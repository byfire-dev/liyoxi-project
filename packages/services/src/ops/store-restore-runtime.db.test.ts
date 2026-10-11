import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, loadEnv } from "../index.js";
import { claimDeliveries, consumeDelivery, createEvents } from "../events/index.js";
import type { DeliveryRef, SubscriberEntry } from "../events/index.js";
import { alertsOf, createIdentityContext } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { createProfileTenantLifecycle } from "../profile/index.js";
import { closeEntityIn, createTenant } from "../tenant/index.js";
import {
  connectTestDatabase,
  fakeKeyEnv,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { lifecycleWorld, DAY } from "./__fixtures__/profile-lifecycle.js";
import { createProfileLifecycleAssembly } from "./profile-lifecycle-runtime.js";

const SLOW = 120_000;
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let h: ReturnType<typeof lifecycleWorld>, runtime: ReturnType<typeof createRuntime>;
let scope: ReturnType<typeof createProfileLifecycleAssembly>;
let events: ReturnType<typeof createEvents>, tenant: ReturnType<typeof createTenant>;
let runtimeClosed = true;
const subscriber = "profile.onTenantLifecycle";
beforeAll(async () => {
  h = lifecycleWorld(await db.prisma());
  await redis.raw();
  await openRuntime();
}, SLOW);
async function openRuntime() {
  runtime = createRuntime({
    entry: "api",
    version: "fictional-store-restore",
    clock: h.clock,
    providers: h.fake,
    redisKeyPrefix: redis.prefix,
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
  });
  // API 真实运行时提供基础服务；profile 与 worker 一样绑定本实例订阅处理器。
  scope = createProfileLifecycleAssembly(runtime.assembly);
  events = createEvents({ tx: runtime.tx, clock: h.clock, assembly: scope.assembly });
  tenant = service(runtime.tx);
  scope.attach(
    createProfileTenantLifecycle({
      clock: h.clock,
      tenant,
      approval: runtime.approval,
      events,
      media: runtime.media,
    }),
  );
  runtimeClosed = false;
}
async function closeRuntime() {
  if (runtimeClosed) return;
  runtimeClosed = true;
  scope.close();
  await runtime.close();
}
afterAll(async () => {
  await closeRuntime();
  h?.scope.close();
}, SLOW);

function service(tx: TxRunner) {
  return createTenant({
    tx,
    clock: h.clock,
    flow: runtime.flow,
    assembly: scope.assembly,
    events,
    archiveTimers: runtime.timers,
  });
}
async function world(shared = false) {
  // 同域夹具只建立合法历史档案；archive/restore 均调用真实 producer。
  const owner = await h.owner("new_store");
  await h.make.billingAccount({ entityId: owner.entity.id });
  const primary = await h.make.store({
    entityId: owner.entity.id,
    isPrimary: true,
    qualificationStatus: "verified",
  });
  const member = await h.make.entityMember({
    entityId: owner.entity.id,
    merchantUserId: owner.user.id,
    role: "owner",
    lastStoreId: primary.id,
  });
  await h.prisma.entity.update({
    where: { id: owner.entity.id },
    data: { storeLimitOverride: 2 },
  });
  const ctx = createIdentityContext({
    actor: owner.ctx.actor,
    entityId: owner.entity.id,
    storeId: primary.id,
  });
  const assets = await h.assets(owner, shared),
    draft = await h.draft(owner, "new_store");
  return { ...owner, ctx, primary, member, assets, draft };
}
type World = Awaited<ReturnType<typeof world>>;
const deliveryDeps = () => ({
  tx: runtime.tx,
  subscribers: events.subscribers,
  alerts: alertsOf(scope.assembly),
});
async function claim(w: World, type: "store.archived" | "store.restored") {
  const row = await runtime.tx.run((tx) =>
    tx.outboxEvent.findFirstOrThrow({
      where: { aggregateId: w.store.id, eventType: type },
      orderBy: { seq: "desc" },
    }),
  );
  for (let batch = 0; batch < 10; batch++) {
    if ((await events.expand()).events === 0) break;
    if (batch === 9) throw new Error("真实 outbox 展开未在小夹具界限内结束");
  }
  const { claimed } = await runtime.tx.run((tx) => claimDeliveries(tx));
  const ref = claimed.find((item) => item.eventId === row.id && item.subscriber === subscriber);
  expect(ref).toBeDefined();
  if (!ref) throw new Error("真实 profile 投递没有认领成功");
  return ref;
}
async function archive(w: World) {
  await tenant.archiveStore(w.ctx, { storeId: w.store.id });
  const ref = await claim(w, "store.archived");
  expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
  for (const input of w.assets.inputs)
    expect(await h.readRef(input)).toMatchObject({ state: "released" });
  return ref;
}
async function restore(w: World) {
  const card = await tenant.restoreStore(w.ctx, { storeId: w.store.id });
  expect(card).toMatchObject({ storeId: w.store.id, lifecycle: "active" });
  return claim(w, "store.restored");
}
function observed(handle: SubscriberEntry["handle"]) {
  return {
    ...events.subscribers,
    get(name: string) {
      const entry = events.subscribers.get(name);
      return entry && name === subscriber ? { ...entry, handle } : entry;
    },
  };
}
async function failed(ref: DeliveryRef, code: "FILE_NOT_USABLE" | "FILE_NOT_AVAILABLE") {
  const original = events.subscribers.get(subscriber)!;
  let caught: unknown;
  const subscribers = observed(async (tx, event) => {
    try {
      await original.handle(tx, event);
    } catch (error) {
      caught = error;
      throw error;
    }
  });
  expect(await consumeDelivery({ ...deliveryDeps(), subscribers }, ref)).toBe("retry");
  expect(caught).toMatchObject({ error: code });
  expect(
    await h.prisma.outboxDelivery.findUniqueOrThrow({
      where: { outboxEventId_subscriber: { outboxEventId: ref.eventId, subscriber } },
    }),
  ).toMatchObject({ status: "retry", attempts: 1, consumedAt: null });
}

describe("门店恢复：真实运行时、原投递及档案事务", { timeout: SLOW }, () => {
  it("archive→restore 原事件恢复六条引用，丢弃草稿不复活，重复投递无旁写", async () => {
    const w = await world();
    await archive(w);
    const before = await h.snapshot(w.entity.id),
      docRef = await h.readRef(w.draft.input);
    h.clock.advance(DAY);
    const ref = await restore(w);
    expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
    const after = await h.snapshot(w.entity.id);
    expect(after.profiles[0]).toMatchObject({
      completenessPct: 87,
      requiredFilled: 13,
      requiredTotal: 15,
    });
    for (const input of w.assets.inputs)
      expect(await h.readRef(input)).toEqual({ state: "live", releasedAt: null, keepUntil: null });
    for (const file of w.assets.images)
      expect(after.files.find((row) => row.id === file.id)).toMatchObject({
        firstLinkedAt: before.files.find((row) => row.id === file.id)!.firstLinkedAt,
        purgeAfter: null,
      });
    expect(after.rounds).toEqual(before.rounds);
    expect(after.docs).toEqual(before.docs);
    expect(after.rounds[0]).toMatchObject({ outcome: "discarded" });
    expect(await h.readRef(w.draft.input)).toEqual(docRef);
    expect(after.mediaRows).toEqual(before.mediaRows);
    expect(after.services).toEqual(before.services);
    expect(after.history.filter((row) => row.event === "store.restore")).toHaveLength(1);
    expect(after.events.filter((row) => row.eventType === "store.restored")).toHaveLength(1);
    expect(after.audit.filter((row) => row.action === "tenant.store.restore")).toHaveLength(1);
    const business = await h.snapshot(w.entity.id);
    const delivery = await h.prisma.outboxDelivery.findMany({
      where: { outboxEventId: ref.eventId },
      orderBy: { subscriber: "asc" },
    });
    expect(await consumeDelivery(deliveryDeps(), ref)).toBe("stale");
    expect(await h.snapshot(w.entity.id)).toEqual(business);
    expect(
      await h.prisma.outboxDelivery.findMany({
        where: { outboxEventId: ref.eventId },
        orderBy: { subscriber: "asc" },
      }),
    ).toEqual(delivery);
    expect(h.fake.storage.calls).toEqual([]);
  });

  it("deleted 共用文件清 Logo/门头/服务并重算完整度，其他真实引用恢复", async () => {
    const w = await world(true);
    await archive(w);
    const deletedAt = h.clock.now();
    await h.prisma.fileObject.update({
      where: { id: w.assets.logo.id },
      data: { status: "deleted", deletedAt },
    });
    const previous = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: w.store.id },
    });
    h.clock.advance(DAY);
    const ref = await restore(w),
      now = h.clock.now();
    expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
    const after = await h.snapshot(w.entity.id);
    expect(after.profiles[0]).toMatchObject({
      logoFileId: null,
      completenessPct: 73,
      requiredFilled: 11,
      requiredTotal: 15,
      lockVersion: previous.lockVersion + 1,
    });
    expect(after.mediaRows.find((row) => row.fileId === w.assets.logo.id)).toMatchObject({
      removedAt: now,
    });
    expect(after.services[0]).toMatchObject({ removedAt: now });
    expect(after.files.find((row) => row.id === w.assets.logo.id)).toMatchObject({
      status: "deleted",
      deletedAt,
    });
    for (const input of w.assets.inputs)
      expect(await h.readRef(input)).toMatchObject({
        state: input.fileId === w.assets.logo.id ? "released" : "live",
      });
    const before = await h.snapshot(w.entity.id);
    expect(await consumeDelivery(deliveryDeps(), ref)).toBe("stale");
    expect(await h.snapshot(w.entity.id)).toEqual(before);
  });

  it.each([
    "promoting",
    "deleting",
    "block",
    "scope",
    "category",
    "deleted_block",
    "deleted_scope",
  ] as const)("%s 仍服从原文件规则，真实投递重试且全部档案写入回滚", async (kind) => {
    const w = await world();
    await archive(w);
    if (kind === "scope" || kind === "deleted_scope" || kind === "category") {
      // 文件归属/类别不可变；新建合法文件再建立允许的历史业务列错配。
      const owner = kind === "category" ? w : await h.owner("new_store");
      const file = await h.file(owner, kind === "category" ? "kyc_license" : "profile_image");
      if (kind === "deleted_scope")
        await h.prisma.fileObject.update({
          where: { id: file.id },
          data: { status: "deleted", deletedAt: h.clock.now() },
        });
      await h.prisma.storeProfile.update({
        where: { storeId: w.store.id },
        data: { logoFileId: file.id },
      });
    } else {
      await h.prisma.fileObject.update({
        where: { id: w.assets.logo.id },
        data:
          kind === "promoting" || kind === "deleting"
            ? { status: kind }
            : {
                moderationState: "block",
                ...(kind === "deleted_block"
                  ? { status: "deleted", deletedAt: h.clock.now() }
                  : {}),
              },
      });
    }
    const ref = await restore(w),
      before = await h.snapshot(w.entity.id);
    await failed(ref, kind === "deleted_scope" ? "FILE_NOT_AVAILABLE" : "FILE_NOT_USABLE");
    expect(await h.snapshot(w.entity.id)).toEqual(before);
    expect(before.refs.every((row) => row.state === "released")).toBe(true);
  });

  it("profile 原 Tx 已真实 link/刷新后抛错，消费和业务全回滚", async () => {
    const w = await world();
    await archive(w);
    const ref = await restore(w),
      before = await h.snapshot(w.entity.id);
    const original = events.subscribers.get(subscriber)!,
      sentinel = new Error("恢复原事务提交前故障");
    let visited = false;
    const subscribers = observed(async (tx, event) => {
      await original.handle(tx, event);
      expect(await tx.fileRef.count({ where: { refId: w.store.id, state: "live" } })).toBe(1);
      expect(
        await tx.storeProfile.findUniqueOrThrow({ where: { storeId: w.store.id } }),
      ).toMatchObject({ completenessPct: 87 });
      visited = true;
      throw sentinel;
    });
    expect(await consumeDelivery({ ...deliveryDeps(), subscribers }, ref)).toBe("retry");
    expect(visited).toBe(true);
    expect(await h.snapshot(w.entity.id)).toEqual(before);
    expect(
      await h.prisma.outboxDelivery.findUniqueOrThrow({
        where: { outboxEventId_subscriber: { outboxEventId: ref.eventId, subscriber } },
      }),
    ).toMatchObject({
      status: "retry",
      attempts: 1,
      consumedAt: null,
      lastError: `Error: ${sentinel.message}`,
    });
  });

  it("restore 后再 archive，迟到原 restored 投递不重建引用", async () => {
    const w = await world();
    await archive(w);
    const old = await restore(w);
    h.clock.advance(DAY);
    await archive(w);
    const before = await h.snapshot(w.entity.id);
    expect(await consumeDelivery(deliveryDeps(), old)).toBe("done");
    expect(await h.snapshot(w.entity.id)).toEqual(before);
    expect(before.stores.find((row) => row.id === w.store.id)).toMatchObject({
      lifecycle: "archived",
      archiveReason: "by_owner",
    });
    for (const input of w.assets.inputs)
      expect(await h.readRef(input)).toMatchObject({ state: "released" });
  });
});

async function closer(w: World) {
  const group = await h.prisma.staffGroup.findFirstOrThrow({
    where: { staffRoleKey: "super_admin", isDefault: true },
  });
  const staff = await h.make.staff({
    staffRoleKey: "super_admin",
    staffGroupId: group.id,
    isLead: true,
  });
  return {
    ctx: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    staff: await sampleStaffContext(h.prisma, staff.id, { stepUpAt: h.clock.now() }),
    entityId: w.entity.id,
  };
}
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, wait };
}
type Observer = Awaited<ReturnType<typeof connectTestDatabase>>;
async function blocked(observer: Observer, waiter: number, holder: number) {
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("未看到 restore 与实际主体关闭在两个业务连接间的锁等待");
}
function runtimeSnapshot() {
  return runtime.tx.run((tx) =>
    snapshotTables(tx, [
      "entity",
      "store",
      "store_profile",
      "qualification_submission",
      "qualification_doc",
      "approval_request",
      "store_profile_media",
      "store_service_item",
      "file_object",
      "file_ref",
      "timer",
      "status_transition",
      "audit_log",
      "outbox_event",
    ]),
  );
}

describe("恢复与实际主体关闭共用原锁顺序", { timeout: SLOW }, () => {
  it.each(["restore_first", "close_first"] as const)(
    "%s 两连接等待后重读完整事实",
    async (order) => {
      // 上一运行时先关池；本轮夹具完成后释放其连接，竞争阶段只留两个真实业务连接。
      await closeRuntime();
      const w = await world();
      await openRuntime();
      await archive(w);
      const actor = await closer(w),
        hold = gate(),
        waiting = gate();
      await h.prisma.$disconnect();
      let holderPid = 0,
        waiterPid = 0;
      const runner = (first: boolean): TxRunner => ({
        run: (fn, options) =>
          runtime.tx.run(async (tx) => {
            const [row] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            if (!row) throw new Error("真实事务未返回 backend PID");
            if (first) holderPid = row.pid;
            else {
              waiterPid = row.pid;
              waiting.enter();
            }
            const value = await fn(tx);
            if (first) {
              hold.enter();
              await hold.wait;
            }
            return value;
          }, options),
      });
      const close = (tx: TxRunner, activeStoreCount: number) =>
        tx.run((handle) =>
          closeEntityIn(
            handle,
            {
              assembly: scope.assembly,
              clock: h.clock,
              flow: runtime.flow,
              timers: runtime.timers,
            },
            actor,
            {
              entityId: w.entity.id,
              reasonText: "主体申请结束全部经营服务",
              confirm: { activeStoreCount, activeMemberCount: 1 },
            },
          ),
        );
      const observer = await connectTestDatabase(db.name, { role: null });
      const first = Promise.allSettled([
        order === "restore_first"
          ? service(runner(true)).restoreStore(w.ctx, { storeId: w.store.id })
          : close(runner(true), 1),
      ]);
      let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([
          hold.entered,
          first.then(([result]) => {
            throw result?.status === "rejected" ? result.reason : new Error("未进入提交门闩");
          }),
        ]);
        second = Promise.allSettled([
          order === "restore_first"
            ? close(runner(false), 2)
            : service(runner(false)).restoreStore(w.ctx, { storeId: w.store.id }),
        ]);
        await waiting.entered;
        expect(holderPid).not.toBe(waiterPid);
        await blocked(observer, waiterPid, holderPid);
        const connections = await observer.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' ORDER BY pid",
        );
        expect(connections.rows.map((row) => row.pid)).toEqual(
          [holderPid, waiterPid].sort((a, b) => a - b),
        );
        hold.release();
        expect((await first)[0]?.status).toBe("fulfilled");
        const [result] = await second;
        if (order === "restore_first") expect(result?.status).toBe("fulfilled");
        else
          expect(result).toMatchObject({ status: "rejected", reason: { error: "NOT_A_MEMBER" } });
        expect(
          await runtime.tx.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: w.entity.id } })),
        ).toMatchObject({ lifecycle: "closed" });
        expect(
          await runtime.tx.run((tx) =>
            tx.store.count({ where: { entityId: w.entity.id, lifecycle: "active" } }),
          ),
        ).toBe(0);
        const after = await runtime.tx.run(async (tx) => ({
          history: await tx.statusTransition.findMany({ where: { entityId: w.entity.id } }),
          events: await tx.outboxEvent.findMany({ where: { entityId: w.entity.id } }),
        }));
        expect(after.history.filter((row) => row.event === "entity.close")).toHaveLength(1);
        expect(after.events.filter((row) => row.eventType === "entity.closed")).toHaveLength(1);
        expect(after.events.filter((row) => row.eventType === "store.restored")).toHaveLength(
          order === "restore_first" ? 1 : 0,
        );
        if (order === "restore_first") {
          const ref = await claim(w, "store.restored"),
            before = await runtimeSnapshot();
          expect(await consumeDelivery(deliveryDeps(), ref)).toBe("done");
          expect(await runtimeSnapshot()).toEqual(before);
        }
        for (const input of w.assets.inputs)
          expect(
            await runtime.tx.run((tx) => runtime.media.readRefRetention(tx, input)),
          ).toMatchObject({ state: "released" });
      } finally {
        hold.release();
        await first;
        await second;
        await observer.end();
        await closeRuntime();
      }
    },
  );
});
