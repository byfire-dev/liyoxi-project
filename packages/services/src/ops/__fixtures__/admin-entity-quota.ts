import type { EntityQuotaUpdateBody, StoreCreateBody } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../../approval/index.js";
import type { AuditRequestMeta } from "../../audit/index.js";
import type { StaffContext } from "../../authz/index.js";
import { createConfig } from "../../config/index.js";
import { createDocs } from "../../docs/index.js";
import { createFlow } from "../../flow/index.js";
import {
  AppError,
  createBizNoIssuer,
  createIdempotencyContext,
  createIdentityContext,
  uuidv7,
} from "../../kernel/index.js";
import type { TxRunner } from "../../kernel/index.js";
import { readTenantAdminBillingFacts } from "../../billing/index.js";
import { countOrderItemsByPhase } from "../../order/index.js";
import { readEntityAssetCounts } from "../../media/index.js";
import {
  createProfile,
  createStoreProfileAssetInitializer,
  readEntityStoreProfileFacts,
} from "../../profile/index.js";
import { createTenant } from "../../tenant/index.js";
import type { TenantAdminReadDeps, TenantDeps } from "../../tenant/index.js";
import {
  assertCurrentSessionForTest,
  createIdentityForTest,
  currentSessionOpenidForTest,
  createMediaAssetsHarness,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
} from "../../testing/index.js";

export const SLOW = 120_000;
export const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "billing_account",
  "billing_order",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "point_ledger_entry",
  "store_profile",
  "qualification_submission",
  "store_asset",
  "file_ref",
  "media_job",
  "store_service_item",
  "store_profile_media",
  "store_asset_file",
  "store_asset_tag",
  "file_object",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
  "idempotency_record",
  "param_value",
];
export const realReaders: TenantAdminReadDeps = {
  billing: readTenantAdminBillingFacts,
  profiles: readEntityStoreProfileFacts,
  assets: readEntityAssetCounts,
  orders: countOrderItemsByPhase,
};
const APPID = "wxlyxtest00000001";
let serial = 74_000_000;
export async function quotaHarness(prisma: PrismaClient) {
  const h = await createMediaAssetsHarness(prisma);
  const flow = createFlow({ clock: h.clock, events: h.events, assembly: h.assembly });
  const approval = createApproval({
    ...h,
    flow,
    sla: h.assets.sla,
    timers: h.timers,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const profile = (runner: TxRunner) =>
    createProfile({
      ...h,
      tx: runner,
      approval,
      tenant,
      keyring: () => TEST_KEYRING,
      wechat: h.fake.wechat,
      currentOpenid: (principal) =>
        runner.run((tx) => currentSessionOpenidForTest(tx, principal, APPID)),
    });
  const storeCreation = (runner: TxRunner): NonNullable<TenantDeps["storeCreation"]> => ({
    async assertSession(tx, principal, now) {
      await assertCurrentSessionForTest(tx, principal, now, APPID);
    },
    async validateBasics(ctx, principal, body) {
      const membership = await runner.run((tx) =>
        tenant.resolveMembership(tx, {
          merchantUserId: principal.merchantUserId,
          storeId: ctx.storeId!,
        }),
      );
      if (!membership) throw new AppError("NOT_A_MEMBER");
      await profile(runner).validateStoreBasics(
        { ctx, principal, membership },
        {
          draft: false,
          lockVersion: 0,
          storeName: body.name,
          industryCode: body.industryCode,
          categoryCode: body.categoryCode,
          address: {
            provinceCode: null,
            cityCode: null,
            districtCode: null,
            zoneCode: null,
            detail: body.addressDetail,
            poiName: null,
            latitude: null,
            longitude: null,
          },
        },
      );
    },
    async initialize(tx, ctx, principal, input) {
      const owner = createStoreProfileAssetInitializer({
        clock: h.clock,
        tenant,
        media: h.media,
        expectedAppid: APPID,
        sla: h.assets.sla,
        timers: h.timers,
      });
      await owner.apply(tx, await owner.prepare(tx, ctx, principal, input));
    },
  });
  function service(runner: TxRunner = h.tx, adminRead: TenantAdminReadDeps | null = realReaders) {
    return createTenant({
      tx: runner,
      clock: h.clock,
      events: h.events,
      assembly: h.assembly,
      flow: createFlow({ clock: h.clock, events: h.events, assembly: h.assembly }),
      archiveTimers: h.timers,
      storeCreation: storeCreation(runner),
      ...(adminRead ? { adminRead } : {}),
    });
  }
  const tenant = service();
  const identity = createIdentityForTest({
    ...h,
    flow,
    tenant,
    docs: createDocs({ tx: h.tx, clock: h.clock }),
    config: createConfig({ db: prisma, clock: h.clock, redis: null }),
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    appid: APPID,
  });
  const versions = await Promise.all(
    ["user", "privacy"].map(
      async (agreementKey) =>
        (await prisma.agreementVersion.findFirst({ where: { agreementKey, status: "active" } })) ??
        h.make.agreementVersion({ agreementKey }),
    ),
  );
  for (const [code, parentCode] of [
    ["C990", null],
    ["C991", "C990"],
  ] as const)
    await prisma.dictItem.createMany({
      skipDuplicates: true,
      data: [
        {
          id: uuidv7(),
          dictTypeKey: "industry",
          code,
          parentCode,
          name: "额度竞争行业",
          isEnabled: true,
          position: 998,
          ext: { open: true, special: false, requiredCerts: [] },
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      ],
    });
  async function world() {
    const code = uuidv7();
    h.fake.wechat.sessions.set(code, { openid: `quota_${code}` });
    h.fake.wechat.phones.set(code, `139${++serial}`);
    const logged = await identity.phoneLogin(
      {
        requestId: code,
        ip: "203.0.113.74",
        userAgent: "额度测试",
        clientVersion: null,
      },
      {
        loginCode: code,
        phoneCode: code,
        consents: versions.map((v) => ({
          agreementKey: v.agreementKey,
          agreementVersionId: v.id,
        })),
      },
    );
    const checked = await identity.authenticate(logged.token, { ip: "203.0.113.74" });
    if (!checked.ok) throw new Error("真实手机号登录缺会话");
    const principal = checked.principal;
    const created = await tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: principal.merchantUserId, client: "weapp" },
      }),
    );
    const merchant = createIdentityContext({
      actor: { type: "merchant", id: principal.merchantUserId, client: "weapp" },
      entityId: created.entityId,
      storeId: created.storeId,
    });
    const row = await h.make.staff({ staffRoleKey: "super_admin" });
    const staff = await sampleStaffContext(prisma, row.id, { stepUpAt: h.clock.now() });
    const ctx = createIdentityContext({
      actor: { type: "staff", id: row.id, client: "admin" },
      requestId: uuidv7(),
    });
    return {
      entityId: created.entityId,
      storeId: created.storeId,
      memberId: created.memberId,
      principal,
      merchant,
      staff,
      ctx,
    };
  }
  async function input(
    w: Awaited<ReturnType<typeof world>>,
    patch: Partial<EntityQuotaUpdateBody> = {},
  ): Promise<EntityQuotaUpdateBody> {
    const row = await prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });
    return {
      lockVersion: row.lockVersion,
      confirm: {
        storeLimitOverride: row.storeLimitOverride,
        memberLimitOverride: row.memberLimitOverride,
      },
      reasonText: "真实额度调整",
      storeLimitOverride: 4,
      ...patch,
    };
  }
  async function create(
    w: Awaited<ReturnType<typeof world>>,
    side = tenant,
    patch: Partial<StoreCreateBody> = {},
  ) {
    const body: StoreCreateBody = {
      name: "公开额度分店",
      addressDetail: "虚构路一号",
      industryCode: "C990",
      categoryCode: "C991",
      ...patch,
    };
    return side.createStore(w.merchant, body, {
      principal: w.principal,
      idem: createIdempotencyContext({
        mode: "required",
        scope: "m.store.create",
        key: uuidv7(),
        actor: w.merchant.actor,
        request: { method: "POST", body, storeId: w.storeId },
      }),
    });
  }
  return {
    ...h,
    flow,
    tenant,
    service,
    world,
    input,
    create,
    state: () => snapshotTables(prisma, TABLES),
  };
}
export type QuotaHarness = Awaited<ReturnType<typeof quotaHarness>>;
export type QuotaWorld = Awaited<ReturnType<QuotaHarness["world"]>>;
export function quotaCall(
  tenant: ReturnType<typeof createTenant>,
  w: QuotaWorld,
  body: EntityQuotaUpdateBody,
  key = uuidv7(),
  staff: StaffContext = w.staff,
) {
  const meta: AuditRequestMeta = {
    requestId: w.ctx.requestId,
    ip: "203.0.113.74",
    userAgent: "额度测试",
    authMethod: null,
    sessionId: null,
  };
  return tenant.updateEntityQuota(
    w.ctx,
    staff,
    { entityId: w.entityId, ...body },
    {
      meta,
      idem: createIdempotencyContext({
        mode: "required",
        scope: "admin.entity.quota.update",
        actor: w.ctx.actor,
        key,
        request: { method: "PATCH", pathParams: { entityId: w.entityId }, body },
      }),
    },
  );
}
