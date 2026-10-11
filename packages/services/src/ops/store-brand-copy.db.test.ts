import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { standingOf } from "../authz/index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createFlow } from "../flow/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import {
  createStoreProfileAssetInitializer,
  createStoreProfileInitializer,
} from "../profile/index.js";
import type { StoreProfileAssetInitInput, StoreProfileInitPlan } from "../profile/index.js";
import {
  assertSnapshotsEqual,
  snapshotTables,
  connectTestDatabase,
  createMediaAssetsHarness,
  createIdentityForTest,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";

const db = useSeededDatabase("services", { label: "brandinit", max: 1 });
const APPID = "wxlyxtest00000001",
  SLOW = 60_000;
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let tenant: ReturnType<typeof createTenant>, identity: ReturnType<typeof createIdentityForTest>;
let versions: { id: string; agreementKey: string }[],
  serial = 81_000_000;
const initial = { addressDetail: "公开新分店地址", industryCode: "C960", categoryCode: "C961" };
const TABLES = [
  "store_profile",
  "store_service_item",
  "store_profile_media",
  "store_asset",
  "store_asset_file",
  "store_asset_tag",
  "store_asset_insight",
  "file_ref",
  "file_object",
  "timer",
  "media_job",
  "outbox_event",
  "user_session",
  "entity_member",
  "store",
];
beforeAll(async () => {
  h = await createMediaAssetsHarness(await db.prisma());
  const flow = createFlow({ assembly: h.assembly, clock: h.clock, events: h.events });
  tenant = createTenant({ tx: h.tx, clock: h.clock, assembly: h.assembly, flow });
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
    ["C960", null],
    ["C961", "C960"],
  ] as const)
    await h.prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code } },
      update: {},
      create: {
        id: uuidv7(),
        dictTypeKey: "industry",
        code,
        parentCode,
        name: "公开复制行业",
        ext: { open: true, special: false, requiredCerts: [] },
        isEnabled: true,
        position: 996,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
}, 120_000);
afterAll(async () => {
  await h?.close();
}, SLOW);
const factory = (media = h.media, timers = h.timers) =>
  createStoreProfileAssetInitializer({
    clock: h.clock,
    tenant,
    media,
    timers,
    sla: h.assets.sla,
    expectedAppid: APPID,
  });
async function world(
  options: StoreProfileAssetInitInput["copyOptions"] = [
    "basic",
    "service",
    "media",
    "brand_assets",
  ],
) {
  const code = uuidv7(),
    meta = {
      requestId: code,
      ip: "203.0.113.55",
      userAgent: "公开品牌复制夹具",
      clientVersion: null,
    };
  h.fake.wechat.sessions.set(code, { openid: `brand_copy_${code}` });
  h.fake.wechat.phones.set(code, `139${++serial}`);
  const login = await identity.phoneLogin(meta, {
    loginCode: code,
    phoneCode: code,
    consents: versions.map((v) => ({ agreementKey: v.agreementKey, agreementVersionId: v.id })),
  });
  const auth = await identity.authenticate(login.token, { ip: meta.ip });
  if (!auth.ok) throw new Error("真实登录未产生当前会话");
  const principal = auth.principal,
    actor = { type: "merchant" as const, id: principal.merchantUserId, client: "weapp" as const };
  const created = await tenant.createEntity(createIdentityContext({ actor }));
  const ctx = createIdentityContext({
    actor: { ...actor, role: created.role },
    entityId: created.entityId,
    storeId: created.storeId,
  });
  const target = await h.make.store({ entityId: created.entityId });
  const file = await h.make.fileObject({
    category: "profile_image",
    scopeType: "store",
    entityId: created.entityId,
    storeId: created.storeId,
    uploadActorType: "merchant",
    uploadActorId: actor.id,
    uploadClient: "weapp",
  });
  // 此前已存在的合法档案与选项行；仅新店组合入口是本片交付。
  await h.prisma.storeProfile.create({
    data: {
      storeId: created.storeId,
      entityId: created.entityId,
      brandName: "公开源品牌",
      brandIntro: "公开源简介",
      businessHours: [],
      logoFileId: file.id,
      storeTel: "010-12345678",
      avgSpendFen: 9900,
      promoText: "公开源优惠",
      groupBuyText: "公开源团购",
      sellingPointCodes: [],
      sellingNote: "公开源卖点",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.storeServiceItem.create({
    data: {
      id: uuidv7(),
      entityId: created.entityId,
      storeId: created.storeId,
      name: "公开源菜品",
      priceFen: 900,
      originalPriceFen: 1000,
      intro: "公开源菜品说明",
      position: 1,
      imageFileId: file.id,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.storeProfileMedia.create({
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
  const assetFile = await h.make.fileObject({
    category: "store_asset",
    bucket: "asset",
    scopeType: "store",
    entityId: created.entityId,
    storeId: created.storeId,
    uploadActorType: "merchant",
    uploadActorId: actor.id,
    uploadClient: "weapp",
  });
  const asset = await h.media.assets.create(
    {
      identity: ctx,
      merchant: {
        entityId: created.entityId,
        storeId: created.storeId,
        standing: standingOf("owner", "active"),
      },
    },
    { type: "image", fileIds: [assetFile.id], contentTagCodes: ["brand_story"] },
  );
  const input: StoreProfileAssetInitInput = {
    contextStoreId: created.storeId,
    targetStoreId: target.id,
    copyFromStoreId: created.storeId,
    copyOptions: options,
    initial: { ...initial },
  };
  return {
    ...created,
    ctx,
    principal,
    target,
    file,
    assetFile,
    assetId: asset.storeAssetId,
    input,
  };
}
type World = Awaited<ReturnType<typeof world>>;
const run = (w: World, input = w.input, one = factory()) =>
  h.tx.run(async (tx) => one.apply(tx, await one.prepare(tx, w.ctx, w.principal, input)));
const target = async (w: World) => ({
  profile: await h.prisma.storeProfile.findUnique({ where: { storeId: w.target.id } }),
  service: await h.prisma.storeServiceItem.findMany({ where: { storeId: w.target.id } }),
  media: await h.prisma.storeProfileMedia.findMany({ where: { storeId: w.target.id } }),
  assets: await h.prisma.storeAsset.findMany({ where: { storeId: w.target.id } }),
});
const empty = async (w: World) =>
  expect(await target(w)).toEqual({ profile: null, service: [], media: [], assets: [] });
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("组合复制栅栏超时")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function race(
  w: World,
  hold: (client: Awaited<ReturnType<typeof connectTestDatabase>>) => Promise<void>,
  change?: () => void,
) {
  const holder = await connectTestDatabase(db.name),
    observer = await connectTestDatabase(db.name, { role: null });
  let pending: Promise<void> | undefined;
  try {
    await holder.query("BEGIN");
    const hp = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await hold(holder);
    let wp = 0;
    const one = factory();
    pending = h.tx.run(async (tx) => {
      wp = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await one.apply(tx, await one.prepare(tx, w.ctx, w.principal, w.input));
    });
    const settled = Promise.allSettled([pending]);
    await bounded(
      (async () => {
        for (;;) {
          if (wp) {
            expect(wp).not.toBe(hp);
            const row = await observer.query<{ blocked: boolean }>(
              "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
              [wp, hp],
            );
            if (row.rows[0]?.blocked) return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
    );
    change?.();
    await holder.query("COMMIT");
    return (await settled)[0]!;
  } finally {
    await holder.query("ROLLBACK");
    if (pending) await Promise.allSettled([pending]);
    await holder.end();
    await observer.end();
  }
}

describe("四项组合：真实会话owner、首次metadata与双域事务", { timeout: SLOW }, () => {
  it("四项在第一次INSERT写入且无metadata UPDATE；档案三类和品牌素材同TX复制", async () => {
    const w = await world(),
      original = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: w.assetId } });
    const sourceProfile = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: w.storeId },
    });
    const jobs = await h.prisma.mediaJob.count();
    let inserted: unknown,
      updated = 0;
    const one = factory();
    await h.tx.run(async (tx) => {
      const create = vi.spyOn(tx.storeProfile, "create");
      const update = vi.spyOn(tx.storeProfile, "update");
      try {
        await one.apply(tx, await one.prepare(tx, w.ctx, w.principal, w.input));
        expect(create).toHaveBeenCalledTimes(1);
        inserted = create.mock.calls[0]![0].data;
        updated = update.mock.calls.filter(
          ([args]) => "copyOptions" in args.data || "copiedFromStoreId" in args.data,
        ).length;
      } finally {
        create.mockRestore();
        update.mockRestore();
      }
    });
    expect(inserted).toMatchObject({
      storeId: w.target.id,
      copiedFromStoreId: w.storeId,
      copyOptions: ["basic", "service", "media", "brand_assets"],
    });
    expect(updated).toBe(0);
    const rows = await target(w);
    expect(rows.profile).toMatchObject({
      ...initial,
      copiedFromStoreId: w.storeId,
      copyOptions: w.input.copyOptions,
      brandName: sourceProfile.brandName,
      logoFileId: w.file.id,
      storeTel: null,
      avgSpendFen: null,
      promoText: sourceProfile.promoText,
    });
    expect(rows.service).toEqual([
      expect.objectContaining({ name: "公开源菜品", priceFen: 900, imageFileId: w.file.id }),
    ]);
    expect(rows.media).toEqual([
      expect.objectContaining({
        caption: "公开门头",
        fileId: w.file.id,
        copiedFromStoreId: w.storeId,
      }),
    ]);
    expect(rows.assets).toEqual([
      expect.objectContaining({
        sourceStoreAssetId: original.id,
        textBody: original.textBody,
        uploadActorId: original.uploadActorId,
      }),
    ]);
    expect(await h.prisma.storeProfile.findUnique({ where: { storeId: w.storeId } })).toEqual(
      sourceProfile,
    );
    expect(await h.prisma.mediaJob.count()).toBe(jobs);
    expect(h.fake.llm.calls).toEqual([]);
  });
  it("旧三选项公口仍严格拒绝brand_assets，不扩大原API", async () => {
    const w = await world();
    const old = createStoreProfileInitializer({
      clock: h.clock,
      tenant,
      media: h.media,
      expectedAppid: APPID,
    });
    await expect(
      h.tx.run((tx) =>
        old.prepare(tx, w.ctx, w.principal, { ...w.input, copyOptions: ["brand_assets"] as never }),
      ),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    await empty(w);
  });
  it.each(["basic", "service", "media", "brand_assets"] as const)(
    "单独%s只复制所选集合，元数据不混入其他项",
    async (option) => {
      const w = await world([option]);
      await run(w);
      const rows = await target(w);
      expect(rows.profile!.copyOptions).toEqual([option]);
      expect(rows.profile!.brandName).toBe(option === "basic" ? "公开源品牌" : null);
      expect(rows.service).toHaveLength(option === "service" ? 1 : 0);
      expect(rows.media).toHaveLength(option === "media" ? 1 : 0);
      expect(rows.assets).toHaveLength(option === "brand_assets" ? 1 : 0);
    },
  );
  it("缺来源profile是真实空档案，不妨碍品牌素材复制", async () => {
    const w = await world(),
      source = await h.make.store({ entityId: w.entityId });
    await h.prisma.storeAsset.create({
      data: {
        id: uuidv7(),
        entityId: w.entityId,
        storeId: source.id,
        type: "text",
        textBody: "公开历史无档案品牌",
        uploadActorType: "merchant",
        uploadActorId: w.principal.merchantUserId,
        uploadClient: "weapp",
        uploadActorRole: "owner",
        processingState: "processed",
        reviewState: "unreviewed",
        idempotencyKey: uuidv7(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
        storeAssetTags: {
          create: {
            id: uuidv7(),
            dimension: "content",
            tagCode: "brand_story",
            source: "uploader",
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        },
      },
    });
    await run(w, { ...w.input, copyFromStoreId: source.id });
    const rows = await target(w);
    expect(rows.profile!.brandName).toBeNull();
    expect(rows.service).toEqual([]);
    expect(rows.media).toEqual([]);
    expect(rows.assets).toHaveLength(1);
    expect(await h.prisma.storeProfile.findUnique({ where: { storeId: source.id } })).toBeNull();
  });
  it.each(["by_owner", "draft_deleted"] as const)(
    "归档来源%s沿真实profile guard，不由media伪造授权",
    async (archiveReason) => {
      const w = await world();
      await h.prisma.store.update({
        where: { id: w.storeId },
        data: {
          lifecycle: "archived",
          archiveReason,
          archivedAt: h.clock.now(),
          archiveActorType: "merchant",
          archiveActorId: w.principal.merchantUserId,
          archiveClient: "weapp",
        },
      });
      const active = await h.make.store({ entityId: w.entityId });
      const ctx = { ...w.ctx, storeId: active.id },
        one = factory();
      const copy = () =>
        h.tx.run(async (tx) =>
          one.apply(
            tx,
            await one.prepare(tx, ctx, w.principal, { ...w.input, contextStoreId: active.id }),
          ),
        );
      if (archiveReason === "by_owner") {
        await copy();
        expect((await target(w)).assets).toHaveLength(1);
      } else {
        await expect(copy()).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
        await empty(w);
      }
    },
  );
  it.each(["duplicate", "no-source", "foreign-source", "self", "existing", "extra"])(
    "%s组合输入/事实不接受caller授权替身",
    async (kind) => {
      const w = await world(),
        input = { ...w.input, copyOptions: [...w.input.copyOptions] };
      if (kind === "duplicate") input.copyOptions.push("brand_assets");
      if (kind === "no-source") input.copyFromStoreId = null;
      if (kind === "foreign-source") input.copyFromStoreId = h.merchant.store.id;
      if (kind === "self") input.copyFromStoreId = w.target.id;
      if (kind === "existing")
        await h.prisma.storeProfile.create({
          data: {
            storeId: w.target.id,
            entityId: w.entityId,
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
      if (kind === "extra") Object.assign(input, { owner: true });
      const before = await snapshotTables(h.prisma, TABLES);
      await expect(run(w, input)).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
  );
  it.each(["clone", "other-instance", "other-tx", "twice"])(
    "组合计划%s拒绝，不能携带授权metadata",
    async (kind) => {
      const w = await world(),
        one = factory();
      let plan!: StoreProfileInitPlan;
      const before = await snapshotTables(h.prisma, TABLES);
      if (kind === "other-tx") {
        await h.tx.run(async (tx) => {
          plan = await one.prepare(tx, w.ctx, w.principal, w.input);
        });
        await expect(h.tx.run((tx) => one.apply(tx, plan))).rejects.toThrow(TypeError);
      } else
        await expect(
          h.tx.run(async (tx) => {
            plan = await one.prepare(tx, w.ctx, w.principal, w.input);
            if (kind === "twice") await one.apply(tx, plan);
            await (kind === "other-instance" ? factory() : one).apply(
              tx,
              kind === "clone" ? { fileIds: plan.fileIds } : plan,
            );
          }),
        ).rejects.toThrow(TypeError);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
  );
  it("真实两类文件共同410 union，来源输入深拷贝且计划冻结", async () => {
    const w = await world(),
      assetFile = w.assetFile;
    const input = {
        ...w.input,
        initial: { ...w.input.initial },
        copyOptions: [...w.input.copyOptions],
      },
      one = factory();
    await h.tx.run(async (tx) => {
      const plan = await one.prepare(tx, w.ctx, w.principal, input);
      expect(plan.fileIds).toEqual([w.file.id, assetFile.id].sort());
      expect(Object.isFrozen(plan.fileIds)).toBe(true);
      input.initial.addressDetail = "被修改的地址";
      input.copyOptions.length = 0;
      await one.apply(tx, plan);
    });
    const rows = await target(w);
    expect(rows.profile!.addressDetail).toBe(initial.addressDetail);
    expect(rows.profile!.copyOptions).toEqual(w.input.copyOptions);
    expect(
      await h.prisma.fileRef.count({
        where: { refId: rows.assets[0]!.id, fileId: assetFile.id, role: "main", releasedAt: null },
      }),
    ).toBe(1);
  });
  it.each(["idle", "absolute"] as const)("共同410实际等待中%s恰好到期，零目标写", async (kind) => {
    const w = await world(),
      start = h.clock.now(),
      session = await h.prisma.userSession.findUniqueOrThrow({
        where: { id: w.principal.sessionId },
      });
    const expires = kind === "idle" ? session.idleExpiresAt : session.absoluteExpiresAt;
    if (kind === "absolute")
      await h.prisma.userSession.update({
        where: { id: session.id },
        data: { idleExpiresAt: new Date(expires.getTime() + 1) },
      });
    try {
      const result = await race(
        w,
        (holder) =>
          holder
            .query("SELECT id FROM file_object WHERE id=$1 FOR UPDATE", [w.file.id])
            .then(() => undefined),
        () => h.clock.set(expires),
      );
      expect(result).toMatchObject({ status: "rejected", reason: { error: "SESSION_INVALID" } });
      await empty(w);
    } finally {
      h.clock.set(start);
    }
  });
  it.each(["session", "owner", "source"])(
    "最后timer await之后%s事实失效，两个域及timer全部回滚",
    async (kind) => {
      const w = await world(),
        start = h.clock.now(),
        before = await snapshotTables(h.prisma, TABLES);
      const real = h.timers.arm;
      const timers = {
        ...h.timers,
        arm: async (tx: Tx, input: Parameters<typeof real>[1]) => {
          const result = await real(tx, input);
          if (kind === "session") {
            const row = await tx.userSession.findUniqueOrThrow({
              where: { id: w.principal.sessionId },
            });
            h.clock.set(row.idleExpiresAt);
          }
          if (kind === "owner")
            await tx.entityMember.update({
              where: { id: w.memberId },
              data: {
                status: "removed",
                removedAt: h.clock.now(),
                removeReason: "by_owner",
                removeActorType: "merchant",
                removeActorId: w.principal.merchantUserId,
                removeClient: "weapp",
              },
            });
          if (kind === "source")
            await tx.store.update({
              where: { id: w.storeId },
              data: {
                lifecycle: "archived",
                archiveReason: "draft_deleted",
                archivedAt: h.clock.now(),
                archiveActorType: "merchant",
                archiveActorId: w.principal.merchantUserId,
                archiveClient: "weapp",
              },
            });
          return result;
        },
      };
      try {
        await expect(run(w, w.input, factory(h.media, timers))).rejects.toMatchObject({
          error:
            kind === "session"
              ? "SESSION_INVALID"
              : kind === "owner"
                ? "NOT_A_MEMBER"
                : "VALIDATION_FAILED",
        });
      } finally {
        h.clock.set(start);
      }
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
      await empty(w);
    },
  );
  it.each(["member", "source", "file"])("真实%s锁winner先提交后重新检查事实", async (kind) => {
    const w = await world();
    const result = await race(w, async (holder) => {
      if (kind === "member") {
        await holder.query("SELECT id FROM entity_member WHERE id=$1 FOR UPDATE", [w.memberId]);
        await holder.query(
          "UPDATE entity_member SET status='removed',removed_at=$2,remove_reason='by_owner',remove_actor_type='merchant',remove_actor_id=$3,remove_client='weapp' WHERE id=$1",
          [w.memberId, h.clock.now(), w.principal.merchantUserId],
        );
      }
      if (kind === "source") {
        await holder.query("SELECT id FROM store WHERE id=$1 FOR UPDATE", [w.storeId]);
        await holder.query(
          "UPDATE store SET lifecycle='archived',archive_reason='draft_deleted',archived_at=$2,archive_actor_type='merchant',archive_actor_id=$3,archive_client='weapp' WHERE id=$1",
          [w.storeId, h.clock.now(), w.principal.merchantUserId],
        );
      }
      if (kind === "file") {
        await holder.query("SELECT id FROM file_object WHERE id=$1 FOR UPDATE", [w.file.id]);
        await holder.query("UPDATE file_object SET moderation_state='block' WHERE id=$1", [
          w.file.id,
        ]);
      }
    });
    expect(result).toMatchObject({
      status: "rejected",
      reason: {
        error:
          kind === "member"
            ? "NOT_A_MEMBER"
            : kind === "source"
              ? "NOT_A_MEMBER"
              : "FILE_NOT_USABLE",
      },
    });
    await empty(w);
  });
  it.each(["completeness", "asset-link", "asset-timer", "outer"])(
    "%s失败回滚三档案集合和品牌metadata，不留半成品",
    async (stage) => {
      const w = await world(),
        before = await snapshotTables(h.prisma, TABLES),
        failure = new Error("公开组合回滚栅栏");
      const timers =
        stage === "asset-timer"
          ? {
              ...h.timers,
              arm: async () => {
                throw failure;
              },
            }
          : h.timers;
      const real = h.media.link;
      const media =
        stage === "asset-link"
          ? {
              ...h.media,
              link: async (...args: Parameters<typeof real>) => {
                if (args[1].refType === "store_asset") throw failure;
                return real(...args);
              },
            }
          : h.media;
      const one = factory(media, timers);
      await expect(
        h.tx.run(async (tx) => {
          const plan = await one.prepare(tx, w.ctx, w.principal, w.input);
          let spy: { mockRestore(): void } | undefined;
          if (stage === "completeness")
            spy = vi.spyOn(tx.storeProfile, "update").mockRejectedValue(failure);
          try {
            await one.apply(tx, plan);
            if (stage === "outer") throw failure;
          } finally {
            spy?.mockRestore();
          }
        }),
      ).rejects.toThrow("公开组合回滚栅栏");
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
      await empty(w);
    },
  );
  it("同一新店只容一份首次INSERT，第二个计划不能覆写metadata或再复制", async () => {
    const w = await world();
    await run(w);
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(run(w)).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  });
});
