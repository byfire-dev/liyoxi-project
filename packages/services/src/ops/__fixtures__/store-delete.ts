import type { Prisma, PrismaClient } from "@liyoxi/db";
import { createConfig } from "../../config/index.js";
import { createDocs } from "../../docs/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  AppError,
  alertsOf,
  createIdempotencyContext,
  createIdentityContext,
  createTxRunner,
  uuidv7,
} from "../../kernel/index.js";
import type { IdentityContext, TxRunner } from "../../kernel/index.js";
import { createInvitationExpiry, createTenant } from "../../tenant/index.js";
import type { TenantDeps } from "../../tenant/index.js";
import {
  assertCurrentSessionForTest,
  createIdentityForTest,
  currentSessionOpenidForTest,
  snapshotTables,
  TEST_KEYRING,
} from "../../testing/index.js";
import { createTimers } from "../../timers/index.js";
import { createInvitationAssembly } from "../invitation-runtime.js";
import { readStoreDraftFacts } from "../store-draft-facts.js";
import { lifecycleWorld } from "./profile-lifecycle.js";

export const SLOW = 120_000;
export const APPID = "wxstoredelete0001";
export const TABLES = [
  "merchant_user",
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "timer",
  "status_transition",
  "audit_log",
  "outbox_event",
  "idempotency_record",
  "portal_session",
  "user_session",
  "agreement_consent",
  "qualification_submission",
  "qualification_doc",
  "store_profile",
  "store_profile_media",
  "store_service_item",
  "file_object",
  "file_ref",
  "store_asset",
  "store_asset_usage",
];
type Base = ReturnType<typeof lifecycleWorld>;
export function deleteServices(prisma: PrismaClient, base: Base, runner?: TxRunner) {
  const tx = runner ?? createTxRunner({ prisma, appEnv: "test" });
  const scope = createInvitationAssembly(base.assembly),
    assembly = scope.assembly;
  const clock = base.clock,
    events = createEvents({ tx, clock, assembly });
  const flow = createFlow({ clock, events, assembly }),
    timers = createTimers({ assembly });
  const expiry = createInvitationExpiry({ clock, flow, timers });
  scope.attach(expiry);
  async function check(
    principal: Parameters<typeof currentSessionOpenidForTest>[1],
    content: string,
  ) {
    const openid = await tx.run((handle) => currentSessionOpenidForTest(handle, principal, APPID));
    const result = await base.fake.wechat.checkText({ openid, scene: "profile", content });
    if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
    if (result.value.verdict !== "pass")
      throw new AppError("CONTENT_REJECTED", { details: { fields: ["displayName"] } });
  }
  const deps: TenantDeps = {
    tx,
    clock,
    flow,
    assembly,
    events,
    archiveTimers: timers,
    readStoreDraftFacts,
    invitations: {
      timers,
      keyring: () => TEST_KEYRING,
      checkRemark: check,
      accept: {
        assertSession: (handle, principal, now) =>
          assertCurrentSessionForTest(handle, principal, now, APPID),
        checkName: check,
      },
    },
  };
  const tenant = createTenant(deps);
  const identity = createIdentityForTest({
    tx,
    clock,
    events,
    flow,
    assembly,
    tenant,
    config: createConfig({ db: prisma, clock, redis: null }),
    docs: createDocs({ tx, clock }),
    wechat: base.fake.wechat,
    keyring: () => TEST_KEYRING,
    appid: APPID,
  });
  return {
    tx,
    clock,
    assembly,
    events,
    flow,
    timers,
    expiry,
    tenant,
    identity,
    deps,
    timerDeps: { tx, assembly, registry: timers.registry, clock, alerts: alertsOf(assembly) },
    close: () => scope.close(),
  };
}
export function deleteContext(userId: string, entityId?: string, storeId?: string) {
  return createIdentityContext({
    actor: { type: "merchant", id: userId, client: "weapp" },
    ...(entityId ? { entityId } : {}),
    ...(storeId ? { storeId } : {}),
    requestId: `req_delete_${uuidv7()}`,
  });
}
export function deleteIdem(ctx: IdentityContext, storeId: string, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.store.delete",
    actor: ctx.actor,
    key,
    request: { method: "POST", pathParams: { storeId }, body: null, storeId: ctx.storeId },
  });
}
let loginSequence = 0;
export function deleteHarness(prisma: PrismaClient) {
  const base = lifecycleWorld(prisma),
    service = deleteServices(prisma, base);
  async function world() {
    // 合法已认证主体/第二家未提交门店前史；不冒称本片交付新增门店 producer。
    const own = await base.owner("new_store");
    const primary = await base.make.store({
      entityId: own.entity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    });
    const member = await base.make.entityMember({
      entityId: own.entity.id,
      merchantUserId: own.user.id,
      role: "owner",
      lastStoreId: primary.id,
    });
    await base.make.billingAccount({ entityId: own.entity.id });
    await prisma.entity.update({ where: { id: own.entity.id }, data: { storeLimitOverride: 2 } });
    return { ...own, primary, member, ctx: deleteContext(own.user.id, own.entity.id, primary.id) };
  }
  async function clerk(w: Awaited<ReturnType<typeof world>>, storeIds = [w.store.id]) {
    const user = await base.make.merchantUser();
    const member = await base.make.entityMember({
      entityId: w.entity.id,
      merchantUserId: user.id,
      invitedByMemberId: w.member.id,
      lastStoreId: storeIds[0] ?? null,
    });
    for (const storeId of storeIds)
      await base.make.storeMember({
        entityId: w.entity.id,
        entityMemberId: member.id,
        storeId,
        addedByMemberId: w.member.id,
      });
    return { user, member };
  }
  async function person() {
    const versions = await Promise.all(
      ["user", "privacy"].map(
        async (agreementKey) =>
          (await prisma.agreementVersion.findFirst({
            where: { agreementKey, status: "active" },
          })) ?? base.make.agreementVersion({ agreementKey }),
      ),
    );
    const n = ++loginSequence,
      loginCode = `delete-login-${n}`,
      phoneCode = `delete-phone-${n}`;
    base.fake.wechat.sessions.set(loginCode, { openid: `delete-openid-${n}` });
    base.fake.wechat.phones.set(phoneCode, `139${String(72_000_000 + n).padStart(8, "0")}`);
    const result = await service.identity.phoneLogin(
      {
        requestId: `req_delete_login_${n}`,
        ip: "203.0.113.10",
        userAgent: "delete-test",
        clientVersion: null,
      },
      {
        loginCode,
        phoneCode,
        consents: versions.map((v) => ({ agreementKey: v.agreementKey, agreementVersionId: v.id })),
      },
    );
    const checked = await service.identity.authenticate(result.token, { ip: "203.0.113.10" });
    if (!checked.ok) throw new Error("真实登录未生成有效会话");
    return { principal: checked.principal, ctx: deleteContext(checked.principal.merchantUserId) };
  }
  async function card(
    w: Awaited<ReturnType<typeof world>>,
    clientRequestId = uuidv7(),
    side = service,
  ) {
    return side.tenant.createInvitation(deleteContext(w.user.id, w.entity.id, w.store.id), {
      clientRequestId,
    });
  }
  function asset(
    w: Awaited<ReturnType<typeof world>>,
    extra: Partial<Prisma.StoreAssetCreateManyInput> = {},
  ) {
    const now = base.clock.now();
    return prisma.storeAsset.create({
      data: {
        id: uuidv7(),
        entityId: w.entity.id,
        storeId: w.store.id,
        type: "text",
        textBody: "合法历史素材",
        uploadActorType: "merchant",
        uploadActorId: w.user.id,
        uploadActorRole: "owner",
        uploadClient: "weapp",
        processingState: "pending",
        reviewState: "unreviewed",
        adoptedCount: 0,
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
        ...extra,
      },
    });
  }
  async function business(
    w: Awaited<ReturnType<typeof world>>,
    kind: "orders" | "ads" | "channelAccounts" | "serviceTickets" | "originalAssets",
    terminal = true,
  ) {
    const now = base.clock.now(),
      id = uuidv7(),
      scope = { entityId: w.entity.id, storeId: w.store.id };
    // 尚未交付的 producer 仅建立完整合法历史；从不把工厂调用算作公开业务入口。
    if (kind === "orders")
      return base.make.dramaOrder({ ...scope, status: terminal ? "cancelled" : "producing" });
    if (kind === "originalAssets") return asset(w);
    if (kind === "channelAccounts")
      return prisma.channelAccount.create({
        data: {
          id,
          ...scope,
          platform: "douyin",
          accountName: "历史账号",
          accountUid: id,
          accountUidNorm: id,
          status: terminal ? "unbound" : "pending_verify",
          unboundAt: terminal ? now : null,
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    if (kind === "serviceTickets")
      return prisma.serviceTicket.create({
        data: {
          id,
          ...scope,
          ticketNo: `KF20260105${id.replaceAll("-", "").slice(-6)}`,
          source: "weapp",
          submitterUserId: w.user.id,
          typeCode: "K01",
          priority: "mid",
          description: "合法工单历史",
          status: "closed",
          closedAt: now,
          closeReason: "invalid",
          closeNote: "历史工单已关闭",
          solutionDueAt: new Date(now.getTime() + 86_400_000),
          slaSnapshot: { solution: {} },
          createdAt: now,
          updatedAt: now,
        },
      });
    const hold = await base.make.pointHold({
      ...scope,
      purpose: "ad",
      refType: "ad",
      refId: id,
      status: terminal ? "released" : "held",
    });
    const consent = await base.make.agreementConsent({
      ...scope,
      scene: "ad_request",
      merchantUserId: w.user.id,
      bizId: id,
    });
    return prisma.ad.create({
      data: {
        id,
        ...scope,
        adNo: `GG20260105${id.replaceAll("-", "").slice(-6)}`,
        requestedByUserId: w.user.id,
        type: "opening",
        durationSec: 3,
        promoPointCodes: ["TEST"],
        status: terminal ? "cancelled" : "pending_assign",
        cancelledAt: terminal ? now : null,
        cancelReasonCode: terminal ? "merchant_request" : null,
        unitPricePoints: 100,
        discountBp: 10000,
        chargePoints: 100,
        pricingSnapshot: {},
        pointHoldId: hold.id,
        freeRevisionQuota: 2,
        latestVersionNo: 0,
        agreementConsentId: consent.id,
        submittedAt: now,
        firstDueAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  return {
    ...base,
    ...service,
    prisma,
    base,
    world,
    clerk,
    card,
    person,
    asset,
    business,
    state: () => snapshotTables(prisma, TABLES),
    close() {
      service.close();
      base.scope.close();
    },
  };
}
export type DeleteHarness = ReturnType<typeof deleteHarness>;
export type DeleteWorld = Awaited<ReturnType<DeleteHarness["world"]>>;
