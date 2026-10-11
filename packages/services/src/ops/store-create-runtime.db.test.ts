import { StoreCardSchema } from "@liyoxi/contract";
import type { StoreCreateBody } from "@liyoxi/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { standingOf } from "../authz/index.js";
import { createApproval } from "../approval/index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createFlow } from "../flow/index.js";
import {
  AppError,
  createBizNoIssuer,
  createIdempotencyContext,
  createIdentityContext,
  guardProviderCall,
  uuidv7,
} from "../kernel/index.js";
import { createProfile, createStoreProfileAssetInitializer } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import type { Tenant, TenantDeps } from "../tenant/index.js";
import {
  assertCurrentSessionForTest,
  connectTestDatabase,
  createIdentityForTest,
  currentSessionOpenidForTest,
  createMediaAssetsHarness,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";

const db = useSeededDatabase("services", { label: "createcombo", max: 1 });
const APPID = "wxlyxtest00000001",
  SLOW = 60_000;
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let tenant: Tenant,
  profile: ReturnType<typeof createProfile>,
  identity: ReturnType<typeof createIdentityForTest>;
let versions: { id: string; agreementKey: string }[],
  serial = 83_000_000;
type Ports = NonNullable<TenantDeps["storeCreation"]>;
const tables = [
  "store",
  "store_profile",
  "store_service_item",
  "store_profile_media",
  "store_asset",
  "store_asset_file",
  "store_asset_tag",
  "file_ref",
  "file_object",
  "media_job",
  "timer",
  "status_transition",
  "audit_log",
  "outbox_event",
  "entity_member",
  "store_member",
];
const body: StoreCreateBody = {
  name: "公开组合新店",
  addressDetail: "公开新址一号",
  industryCode: "C980",
  categoryCode: "C981",
};
let ports: Ports;
beforeAll(async () => {
  h = await createMediaAssetsHarness(await db.prisma());
  const flow = createFlow({ clock: h.clock, assembly: h.assembly, events: h.events });
  const approval = createApproval({
    assembly: h.assembly,
    clock: h.clock,
    flow,
    events: h.events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const initializer = () =>
    createStoreProfileAssetInitializer({
      clock: h.clock,
      tenant,
      media: h.media,
      expectedAppid: APPID,
      sla: h.assets.sla,
      timers: h.timers,
    });
  ports = {
    async assertSession(tx, principal, now) {
      await assertCurrentSessionForTest(tx, principal, now, APPID);
    },
    async validateBasics(ctx, principal, input) {
      const membership = await h.tx.run((tx) =>
        tenant.resolveMembership(tx, {
          merchantUserId: principal.merchantUserId,
          storeId: ctx.storeId!,
        }),
      );
      if (!membership) throw new AppError("NOT_A_MEMBER");
      guardProviderCall({ provider: "wechat", method: "checkText" });
      await profile.validateStoreBasics(
        { ctx, principal, membership },
        {
          draft: false,
          lockVersion: 0,
          storeName: input.name,
          industryCode: input.industryCode,
          categoryCode: input.categoryCode,
          address: {
            provinceCode: null,
            cityCode: null,
            districtCode: null,
            zoneCode: null,
            detail: input.addressDetail,
            poiName: null,
            latitude: null,
            longitude: null,
          },
        },
      );
    },
    async initialize(tx, ctx, principal, input) {
      const owner = initializer();
      await owner.apply(tx, await owner.prepare(tx, ctx, principal, input));
    },
  };
  tenant = createTenant({ ...h, flow, archiveTimers: h.timers, storeCreation: ports });
  profile = createProfile({
    ...h,
    tenant,
    approval,
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: (principal) =>
      h.tx.run((tx) => currentSessionOpenidForTest(tx, principal, APPID)),
  });
  identity = createIdentityForTest({
    ...h,
    flow,
    tenant,
    docs: createDocs({ tx: h.tx, clock: h.clock }),
    config: createConfig({ db: h.prisma, clock: h.clock, redis: null }),
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    appid: APPID,
  });
  versions = await Promise.all(
    ["user", "privacy"].map(
      async (agreementKey) =>
        (await h.prisma.agreementVersion.findFirst({
          where: { agreementKey, status: "active" },
        })) ?? h.make.agreementVersion({ agreementKey }),
    ),
  );
  for (const [code, parentCode] of [
    ["C980", null],
    ["C981", "C980"],
  ] as const)
    await h.prisma.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "industry",
        code,
        parentCode,
        name: "公开组合行业",
        isEnabled: true,
        position: 998,
        ext: { open: true, special: false, requiredCerts: [] },
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
}, 120_000);
afterAll(async () => {
  await h?.close();
}, SLOW);
async function world() {
  const code = uuidv7();
  h.fake.wechat.sessions.set(code, { openid: `store_combo_${code}` });
  h.fake.wechat.phones.set(code, `139${++serial}`);
  const logged = await identity.phoneLogin(
    { requestId: code, ip: "203.0.113.58", userAgent: "公开创建夹具", clientVersion: null },
    {
      loginCode: code,
      phoneCode: code,
      consents: versions.map((row) => ({
        agreementKey: row.agreementKey,
        agreementVersionId: row.id,
      })),
    },
  );
  const checked = await identity.authenticate(logged.token, { ip: "203.0.113.58" });
  if (!checked.ok) throw new Error("真实登录未产生会话");
  const principal = checked.principal,
    actor = {
      type: "merchant" as const,
      id: principal.merchantUserId,
      client: "weapp" as const,
      role: "owner" as const,
    };
  const created = await tenant.createEntity(createIdentityContext({ actor }));
  const ctx = createIdentityContext({
    actor,
    entityId: created.entityId,
    storeId: created.storeId,
  });
  await h.prisma.entity.update({
    where: { id: created.entityId },
    data: { storeLimitOverride: 3 },
  });
  // 来源档案是合法既有资料；新分店与所有复制写入必须由真实公开命令完成。
  const file = await h.make.fileObject({
    category: "profile_image",
    scopeType: "store",
    entityId: created.entityId,
    storeId: created.storeId,
    uploadActorType: "merchant",
    uploadActorId: actor.id,
    uploadClient: "weapp",
  });
  await h.prisma.storeProfile.create({
    data: {
      storeId: created.storeId,
      entityId: created.entityId,
      brandName: "公开源品牌",
      brandIntro: "公开源介绍",
      businessHours: [],
      logoFileId: file.id,
      storeTel: "010-12345678",
      avgSpendFen: 900,
      promoText: "公开优惠",
      groupBuyText: "公开团购",
      sellingPointCodes: [],
      sellingNote: "公开卖点",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const item = await h.prisma.storeServiceItem.create({
    data: {
      id: uuidv7(),
      entityId: created.entityId,
      storeId: created.storeId,
      name: "公开菜品",
      priceFen: 900,
      originalPriceFen: 1000,
      intro: "公开说明",
      position: 1,
      imageFileId: file.id,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const image = await h.prisma.storeProfileMedia.create({
    data: {
      id: uuidv7(),
      entityId: created.entityId,
      storeId: created.storeId,
      mediaGroup: "door",
      mediaKind: "image",
      fileId: file.id,
      caption: "公开门头",
      position: 1,
      createActorType: "merchant",
      createActorId: actor.id,
      createClient: "weapp",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const mediaActor = {
    identity: ctx,
    merchant: {
      entityId: created.entityId,
      storeId: created.storeId,
      standing: standingOf("owner", "active"),
    },
  };
  const assetFile = await h.stored(mediaActor);
  const asset = await h.media.assets.create(mediaActor, {
    type: "image",
    fileIds: [assetFile.id],
    contentTagCodes: ["brand_story"],
    note: "公开品牌素材",
  });
  return { ...created, ctx, principal, file, item, image, assetFile, assetId: asset.storeAssetId };
}
type World = Awaited<ReturnType<typeof world>>;
async function run(
  w: World,
  copyOptions: StoreCreateBody["copyOptions"] = [],
  command = tenant,
  key = uuidv7(),
) {
  const input = { ...body, copyFromStoreId: w.storeId, copyOptions };
  return command.createStore(w.ctx, input, {
    principal: w.principal,
    idem: createIdempotencyContext({
      mode: "required",
      scope: "m.store.create",
      actor: w.ctx.actor,
      key,
      request: { method: "POST", body: input, storeId: w.storeId },
    }),
  });
}

describe("公开创建命令与真实四项档案/素材组合", { timeout: SLOW }, () => {
  it.each([
    { copyOptions: [] },
    { copyOptions: ["basic"] },
    { copyOptions: ["service"] },
    { copyOptions: ["media"] },
    { copyOptions: ["brand_assets"] },
    { copyOptions: ["basic", "service"] },
    { copyOptions: ["basic", "media"] },
    { copyOptions: ["basic", "brand_assets"] },
    { copyOptions: ["service", "media"] },
    { copyOptions: ["service", "brand_assets"] },
    { copyOptions: ["media", "brand_assets"] },
    { copyOptions: ["basic", "service", "media"] },
    { copyOptions: ["basic", "service", "brand_assets"] },
    { copyOptions: ["basic", "media", "brand_assets"] },
    { copyOptions: ["service", "media", "brand_assets"] },
    { copyOptions: ["basic", "service", "media", "brand_assets"] },
  ] as const)("四项真实组合 %j：新ID、初次metadata、引用和计数精确", async ({ copyOptions }) => {
    const selected: NonNullable<StoreCreateBody["copyOptions"]> = [...copyOptions];
    const w = await world(),
      original = await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: w.storeId } });
    const io = h.fake.storage.calls.length,
      models = h.fake.llm.calls.length;
    const card = await run(w, selected);
    expect(StoreCardSchema.parse(card)).toEqual(card);
    const p = await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: card.storeId } });
    expect(p).toMatchObject({
      copiedFromStoreId: w.storeId,
      copyOptions,
      industryCode: body.industryCode,
      categoryCode: body.categoryCode,
      addressDetail: body.addressDetail,
      brandName: selected.includes("basic") ? original.brandName : null,
      logoFileId: selected.includes("basic") ? w.file.id : null,
      promoText: selected.includes("service") ? original.promoText : null,
      storeTel: null,
      avgSpendFen: null,
    });
    const services = await h.prisma.storeServiceItem.findMany({ where: { storeId: card.storeId } });
    const images = await h.prisma.storeProfileMedia.findMany({ where: { storeId: card.storeId } });
    const assets = await h.prisma.storeAsset.findMany({ where: { storeId: card.storeId } });
    expect(services).toHaveLength(selected.includes("service") ? 1 : 0);
    expect(images).toHaveLength(selected.includes("media") ? 1 : 0);
    expect(assets).toHaveLength(selected.includes("brand_assets") ? 1 : 0);
    if (services[0]) {
      expect(services[0].id).not.toBe(w.item.id);
      expect(services[0]).toMatchObject({
        name: w.item.name,
        priceFen: w.item.priceFen,
        imageFileId: w.file.id,
      });
    }
    if (images[0]) {
      expect(images[0].id).not.toBe(w.image.id);
      expect(images[0]).toMatchObject({ fileId: w.file.id, copiedFromStoreId: w.storeId });
    }
    if (assets[0]) {
      expect(assets[0].id).not.toBe(w.assetId);
      expect(assets[0]).toMatchObject({
        entityId: w.entityId,
        sourceStoreAssetId: w.assetId,
        processingState: "processing",
      });
      expect(
        await h.prisma.storeAssetFile.findMany({ where: { storeAssetId: assets[0].id } }),
      ).toMatchObject([{ fileId: w.assetFile.id }]);
      expect(await h.prisma.mediaJob.count({ where: { parentId: assets[0].id } })).toBe(0);
      expect(
        await h.prisma.timer.count({
          where: { subjectId: assets[0].id, kind: "sla.breach", status: "scheduled" },
        }),
      ).toBe(1);
    }
    expect(
      await h.prisma.fileRef.count({
        where: {
          refId: {
            in: [
              card.storeId,
              ...services.map((row) => row.id),
              ...images.map((row) => row.id),
              ...assets.map((row) => row.id),
            ],
          },
          state: "live",
        },
      }),
    ).toBe(
      Number(selected.includes("basic")) +
        Number(selected.includes("service")) +
        Number(selected.includes("media")) +
        Number(selected.includes("brand_assets")),
    );
    expect(card).toMatchObject({
      isPrimary: false,
      qualificationStatus: "unsubmitted",
      assetCount: assets.length,
    });
    expect(await h.prisma.qualificationSubmission.count({ where: { storeId: card.storeId } })).toBe(
      0,
    );
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: w.storeId } }),
    ).toEqual(original);
    expect(h.fake.storage.calls).toHaveLength(io);
    expect(h.fake.llm.calls).toHaveLength(models);
    await expect(
      h.tx.run((tx) =>
        tx.storeProfile.update({
          where: { storeId: card.storeId },
          data: { copiedFromStoreId: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it("真实文件不可用沿Media.link整笔拒绝，store/event/profile/引用均回滚", async () => {
    const w = await world();
    await h.prisma.fileObject.update({
      where: { id: w.file.id },
      data: { moderationState: "block" },
    });
    const before = await snapshotTables(h.prisma, tables);
    await expect(run(w, ["basic", "service", "media", "brand_assets"])).rejects.toMatchObject({
      error: "FILE_NOT_USABLE",
    });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });

  it("最后真实素材timer写入后抛错，连同新店/所有复制引用原子回滚", async () => {
    const w = await world(),
      before = await snapshotTables(h.prisma, tables);
    const arm = h.timers.arm.bind(h.timers);
    const spy = vi.spyOn(h.timers, "arm").mockImplementation(async (...args) => {
      await arm(...args);
      throw new Error("公开测试回滚栅栏");
    });
    try {
      await expect(run(w, ["basic", "service", "media", "brand_assets"])).rejects.toThrow(
        "公开测试回滚栅栏",
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("未配新端口只拒绝createStore，旧首店/列表/额度原能力仍可用", async () => {
    const w = await world();
    const old = createTenant({
      ...h,
      flow: createFlow({ assembly: h.assembly, events: h.events, clock: h.clock }),
    });
    const before = await snapshotTables(h.prisma, tables);
    await expect(run(w, [], old)).rejects.toMatchObject({ error: "INTERNAL" });
    expect(await old.listStores({ merchantUserId: w.principal.merchantUserId })).toMatchObject({
      viewerRole: "owner",
    });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });

  it.each(["idle", "absolute"] as const)("真实四项共同410等待中%s到期，整笔零写", async (kind) => {
    const w = await world(),
      start = h.clock.now();
    const session = await h.prisma.userSession.findUniqueOrThrow({
      where: { id: w.principal.sessionId },
    });
    const at = kind === "idle" ? session.idleExpiresAt : session.absoluteExpiresAt;
    if (kind === "absolute")
      await h.prisma.userSession.update({
        where: { id: session.id },
        data: { idleExpiresAt: new Date(at.getTime() + 1) },
      });
    const [waiter] = await h.prisma.$queryRaw<
      Array<{ pid: number }>
    >`SELECT pg_backend_pid() AS pid`;
    if (!waiter) throw new Error("真实组合业务PID缺失");
    const holder = await connectTestDatabase(db.name),
      observer = await connectTestDatabase(db.name, { role: null });
    let pending: ReturnType<typeof Promise.allSettled> | undefined;
    const before = await snapshotTables(h.prisma, tables);
    try {
      await holder.query("BEGIN");
      const hp = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      expect(hp).not.toBe(waiter.pid);
      await holder.query("SELECT id FROM file_object WHERE id=$1 FOR UPDATE", [w.file.id]);
      pending = Promise.allSettled([run(w, ["basic", "service", "media", "brand_assets"])]);
      let seen = false;
      const end = Date.now() + 3000;
      do {
        const row = await observer.query<{ blocked: boolean }>(
          "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
          [waiter.pid, hp],
        );
        if (row.rows[0]?.blocked) {
          seen = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 15));
      } while (Date.now() < end);
      expect(seen).toBe(true);
      h.clock.set(at);
      await holder.query("COMMIT");
      expect((await pending)[0]).toMatchObject({
        status: "rejected",
        reason: { error: "SESSION_INVALID" },
      });
      expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      if (pending) await pending;
      h.clock.set(start);
      await holder.end();
      await observer.end();
    }
  });
});
