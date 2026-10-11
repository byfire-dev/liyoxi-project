import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval } from "../approval/index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  lockRows,
  uuidv7,
} from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import { createProfile, createStoreProfileInitializer } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  connectTestDatabase,
  createClock,
  createFactories,
  createFakeProviders,
  createIdentityForTest,
  currentSessionOpenidForTest,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";

const db = useSeededDatabase("services", { label: "profcopyops", max: 1 });
const APPID = "wxlyxtest00000001",
  SLOW = 60_000;
const clock = createClock(),
  fake = createFakeProviders({ clock });
let prisma: PrismaClient, reader: PrismaClient;
let stack: ReturnType<typeof assemble>, make: ReturnType<typeof createFactories>;
let versions: { id: string; agreementKey: string }[];
let identity: ReturnType<typeof createIdentityForTest>,
  serial = 78_000_000;
function assemble(client: PrismaClient) {
  const tx = createTxRunner({ prisma: client, appEnv: "test" }),
    assembly = assembleForTest({ entry: "api" });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ assembly, clock, events });
  const tenant = createTenant({ tx, clock, flow, assembly });
  const media = createMedia({ tx, clock, assembly, events, storage: fake.storage });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const profile = createProfile({
    tx,
    clock,
    assembly,
    events,
    tenant,
    media,
    approval,
    keyring: () => TEST_KEYRING,
    wechat: fake.wechat,
    currentOpenid: (principal) =>
      tx.run((handle) => currentSessionOpenidForTest(handle, principal, APPID)),
  });
  const initializer = createStoreProfileInitializer({ clock, tenant, media, expectedAppid: APPID });
  return { tx, assembly, events, flow, tenant, media, profile, initializer };
}
beforeAll(async () => {
  // 数据库真实建立后才创建第二个业务连接；整个文件只有两条业务连接。
  prisma = await db.prisma();
  reader = createPrismaClient({ connectionString: await db.url(), max: 1 });
  stack = assemble(prisma);
  make = createFactories({ db: prisma, clock });
  versions = await Promise.all(
    ["user", "privacy"].map(
      async (agreementKey) =>
        (await prisma.agreementVersion.findFirst({ where: { agreementKey, status: "active" } })) ??
        make.agreementVersion({ agreementKey }),
    ),
  );
  for (const [code, parentCode] of [
    ["C920", null],
    ["C921", "C920"],
  ] as const)
    await prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code } },
      update: {},
      create: {
        id: uuidv7(),
        dictTypeKey: "industry",
        code,
        name: "公开档案复制行业",
        parentCode,
        isEnabled: true,
        position: 998,
        ext: { open: true, special: false, requiredCerts: [] },
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
  identity = createIdentityForTest({
    ...stack,
    clock,
    docs: createDocs({ tx: stack.tx, clock }),
    config: createConfig({ db: prisma, clock, redis: null }),
    keyring: () => TEST_KEYRING,
    wechat: fake.wechat,
    appid: APPID,
  });
}, 120_000);
afterAll(async () => {
  await reader?.$disconnect();
}, SLOW);
async function world() {
  const code = uuidv7(),
    meta = {
      requestId: code,
      ip: "203.0.113.51",
      userAgent: "公开复制并发夹具",
      clientVersion: null,
    };
  fake.wechat.sessions.set(code, { openid: `profile_copy_ops_${code}` });
  fake.wechat.phones.set(code, `139${++serial}`);
  const login = await identity.phoneLogin(meta, {
    loginCode: code,
    phoneCode: code,
    consents: versions.map((v) => ({ agreementKey: v.agreementKey, agreementVersionId: v.id })),
  });
  const auth = await identity.authenticate(login.token, { ip: meta.ip });
  if (!auth.ok) throw new Error("真实会话未成立");
  const actor = {
    type: "merchant" as const,
    id: auth.principal.merchantUserId,
    client: "weapp" as const,
  };
  const owner = await stack.tenant.createEntity(createIdentityContext({ actor }));
  const ctx = createIdentityContext({ actor, entityId: owner.entityId, storeId: owner.storeId });
  const file = await make.fileObject({
    category: "profile_image",
    bucket: "asset",
    scopeType: "store",
    entityId: owner.entityId,
    storeId: owner.storeId,
    uploadActorType: "merchant",
    uploadActorId: actor.id,
    uploadClient: "weapp",
  });
  await stack.profile.updateBasic(
    {
      ctx,
      principal: auth.principal,
      membership: { ...owner, role: "owner", storeMode: "active" },
    },
    { draft: true, lockVersion: 0, brandName: "原品牌", logoFileId: file.id },
  );
  const target = await make.store({ entityId: owner.entityId, name: "真实历史分店" });
  const input = {
    contextStoreId: owner.storeId,
    targetStoreId: target.id,
    copyFromStoreId: owner.storeId,
    copyOptions: ["basic" as const],
    initial: { addressDetail: "公开新址", industryCode: "C920", categoryCode: "C921" },
  };
  return { ...owner, ctx, principal: auth.principal, file, target, input };
}
type World = Awaited<ReturnType<typeof world>>;
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("复制测试栅栏超时")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  waiter: number,
  holder: number,
) {
  const until = Date.now() + 2500;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < until);
  throw new Error("未观察到精确两业务连接阻塞");
}
async function waitAndChange(w: World, hold: (tx: Tx) => Promise<void>, change?: () => void) {
  const entered = latch(),
    release = latch();
  let holderPid = 0,
    waiterPid = 0;
  const observer = await connectTestDatabase(db.name, { role: null });
  const held = stack.tx.run(async (tx) => {
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    holderPid = row!.pid;
    await hold(tx);
    entered.release();
    await bounded(release.promise);
  });
  const heldResult = Promise.allSettled([held]);
  let waiting: PromiseSettledResult<void>[] | undefined;
  let run: Promise<void> | undefined;
  try {
    await bounded(
      Promise.race([
        entered.promise,
        held.then(() => {
          throw new Error("holder提前结束");
        }),
      ]),
    );
    const side = assemble(reader);
    run = side.tx.run(async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      waiterPid = row!.pid;
      await side.initializer.apply(
        tx,
        await side.initializer.prepare(tx, w.ctx, w.principal, w.input),
      );
    });
    const settled = Promise.allSettled([run]);
    await bounded(
      (async () => {
        const until = Date.now() + 2500;
        while (!waiterPid && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 5));
        if (!waiterPid) throw new Error("业务等待连接没有形成真实PID");
        expect(waiterPid).not.toBe(holderPid);
        await blocked(observer, waiterPid, holderPid);
      })(),
    );
    change?.();
    release.release();
    expect(await heldResult).toEqual([{ status: "fulfilled", value: undefined }]);
    waiting = await settled;
    return waiting[0]!;
  } finally {
    release.release();
    await heldResult;
    if (run && !waiting) await Promise.allSettled([run]);
    await observer.end();
  }
}
const targetProfile = (w: World) =>
  prisma.storeProfile.findUnique({ where: { storeId: w.target.id } });

describe("档案复制：真实双连接、共同锁图与最终fresh事实", { timeout: SLOW }, () => {
  it.each(["idle", "absolute"] as const)(
    "等待410期间%s到期，相等时拒绝且目标零写",
    async (kind) => {
      const w = await world(),
        start = clock.now();
      const session = await prisma.userSession.findUniqueOrThrow({
        where: { id: w.principal.sessionId },
      });
      const expiry = kind === "idle" ? session.idleExpiresAt : session.absoluteExpiresAt;
      if (kind === "absolute")
        await prisma.userSession.update({
          where: { id: session.id },
          data: { idleExpiresAt: new Date(expiry.getTime() + 1) },
        });
      try {
        const result = await waitAndChange(
          w,
          async (tx) => {
            await lockRows(tx, "file_object", [w.file.id]);
          },
          () => clock.set(expiry),
        );
        expect(result).toMatchObject({ status: "rejected", reason: { error: "SESSION_INVALID" } });
        expect(await targetProfile(w)).toBeNull();
        expect(await prisma.fileRef.count({ where: { refId: w.target.id } })).toBe(0);
      } finally {
        clock.set(start);
      }
    },
  );
  it("等待410后真实block赢家导致整笔FILE_NOT_USABLE，不采用锁前可用事实", async () => {
    const w = await world();
    const result = await waitAndChange(w, async (tx) => {
      await lockRows(tx, "file_object", [w.file.id]);
      await tx.fileObject.update({ where: { id: w.file.id }, data: { moderationState: "block" } });
    });
    expect(result).toMatchObject({ status: "rejected", reason: { error: "FILE_NOT_USABLE" } });
    expect(await targetProfile(w)).toBeNull();
    expect(await prisma.fileRef.count({ where: { refId: w.target.id } })).toBe(0);
  });
  it("真实source writer持130/135，复制等候后读到胜者的新品牌而非旧快照", async () => {
    const w = await world();
    const result = await waitAndChange(w, async (tx) => {
      await lockRows(tx, "store", [w.storeId]);
      await lockRows(tx, "store_profile", [w.storeId]);
      await tx.storeProfile.update({
        where: { storeId: w.storeId },
        data: { brandName: "锁内胜者品牌" },
      });
    });
    expect(result.status).toBe("fulfilled");
    expect(await targetProfile(w)).toMatchObject({ brandName: "锁内胜者品牌" });
  });
  it("等待owner120后真实removed赢家不能借旧ctx继续复制", async () => {
    const w = await world();
    const result = await waitAndChange(w, async (tx) => {
      await lockRows(tx, "entity", [w.entityId]);
      await lockRows(tx, "entity_member", [w.memberId]);
      await tx.entityMember.update({
        where: { id: w.memberId },
        data: {
          status: "removed",
          removedAt: clock.now(),
          removeActorType: "merchant",
          removeActorId: w.principal.merchantUserId,
          removeClient: "weapp",
          removeReason: "draft_abandoned",
        },
      });
    });
    expect(result).toMatchObject({ status: "rejected", reason: { error: "NOT_A_MEMBER" } });
    expect(await targetProfile(w)).toBeNull();
  });
  it("等待context130后by_owner归档阻断当前上下文，即使来源可归档读取", async () => {
    const w = await world();
    const result = await waitAndChange(w, async (tx) => {
      await lockRows(tx, "store", [w.storeId]);
      await tx.store.update({
        where: { id: w.storeId },
        data: {
          lifecycle: "archived",
          archivedAt: clock.now(),
          archiveReason: "by_owner",
          archiveActorType: "merchant",
          archiveActorId: w.principal.merchantUserId,
          archiveClient: "weapp",
        },
      });
    });
    expect(result).toMatchObject({ status: "rejected", reason: { error: "STORE_ARCHIVED" } });
    expect(await targetProfile(w)).toBeNull();
  });
  it("同target两次初始化真实串行，只有一个首次INSERT/真实引用", async () => {
    const w = await world();
    const result = await waitAndChange(w, async (tx) => {
      await stack.initializer.apply(
        tx,
        await stack.initializer.prepare(tx, w.ctx, w.principal, w.input),
      );
    });
    expect(result).toMatchObject({ status: "rejected", reason: { error: "VALIDATION_FAILED" } });
    expect(await targetProfile(w)).toMatchObject({
      copiedFromStoreId: w.storeId,
      copyOptions: ["basic"],
    });
    expect(await prisma.fileRef.count({ where: { refId: w.target.id } })).toBe(1);
  });
  it("profile135之后真实370，再共同410完整排序；apply不补低序根/新文件", async () => {
    const w = await world(),
      extra = await make.fileObject({
        category: "profile_image",
        scopeType: "store",
        entityId: w.entityId,
        storeId: w.storeId,
      });
    // 仅合法公开synthetic素材根验证锁协议，不声称已有brand_assets复制owner。
    const asset = await prisma.storeAsset.create({
      data: {
        id: uuidv7(),
        entityId: w.entityId,
        storeId: w.storeId,
        type: "text",
        textBody: "公开锁图素材",
        uploadActorType: "merchant",
        uploadActorId: w.principal.merchantUserId,
        uploadClient: "weapp",
        uploadActorRole: "owner",
        processingState: "pending",
        reviewState: "unreviewed",
        idempotencyKey: uuidv7(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await stack.tx.run(async (tx) => {
      const locks = vi.spyOn(tx, "$queryRawUnsafe");
      try {
        const plan = await stack.initializer.prepare(tx, w.ctx, w.principal, w.input);
        expect(plan.fileIds).toEqual([w.file.id]);
        await lockRows(tx, "store_asset", [asset.id]);
        await lockRows(tx, "file_object", [extra.id, ...plan.fileIds]);
        await stack.initializer.apply(tx, plan);
        const rows = locks.mock.calls.filter((call) => String(call[0]).includes("FOR UPDATE"));
        const common = rows.findIndex((call) => String(call[0]).includes('FROM "file_object"'));
        expect(common).toBeGreaterThan(
          rows.findIndex((call) => String(call[0]).includes('FROM "store_asset"')),
        );
        expect(rows[common]![1]).toEqual([w.file.id, extra.id].sort());
        expect(
          rows.slice(common).every((call) => String(call[0]).includes('FROM "file_object"')),
        ).toBe(true);
      } finally {
        locks.mockRestore();
      }
    });
    expect(await targetProfile(w)).toMatchObject({ logoFileId: w.file.id });
    expect(await prisma.fileRef.count({ where: { fileId: extra.id, refId: w.target.id } })).toBe(0);
    expect(await prisma.storeAsset.findUnique({ where: { id: asset.id } })).toEqual(asset);
  });
});
