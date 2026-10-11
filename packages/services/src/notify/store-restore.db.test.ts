import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, createTenant, loadEnv } from "../index.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import { alertsOf, createIdentityContext, uuidv7 } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";

const SLOW = 120_000;
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
const clock = createClock(),
  providers = createFakeProviders({ clock });
let runtime: ReturnType<typeof createRuntime>;
let tenant: ReturnType<typeof createTenant>;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
const refs = new Map<string, DeliveryRef>();
beforeEach(() => refs.clear());
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  prisma = await db.prisma();
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "lyxtest-store-restore",
    clock,
    providers,
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
  make = createFactories({ db: prisma, clock });
  tenant = createTenant({ ...runtime, clock, archiveTimers: runtime.timers });
  await prisma.notifyScene.update({
    where: { sceneKey: "s.merchant_changed" },
    data: { sendWindow: "immediate" },
  });
}, SLOW);
afterAll(async () => {
  await runtime?.close();
}, SLOW);
async function world() {
  const own = await make.merchant({ verified: true });
  const store = await make.store({ entityId: own.entity.id });
  await prisma.entity.update({ where: { id: own.entity.id }, data: { storeLimitOverride: 2 } });
  const manager = await make.staff({
    wecomBindStatus: "bound",
    wecomUserid: `restore-${uuidv7()}`,
    wecomBoundAt: clock.now(),
  });
  await prisma.store.update({ where: { id: store.id }, data: { deliveryManagerId: manager.id } });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: own.user.id, client: "weapp" },
    entityId: own.entity.id,
    storeId: own.store.id,
    requestId: "req_restore_repeated",
  });
  async function clerk() {
    const user = await make.merchantUser({ displayName: "不得泄露的成员姓名" });
    const member = await make.entityMember({
      entityId: own.entity.id,
      merchantUserId: user.id,
      invitedByMemberId: own.owner.id,
    });
    await make.storeMember({
      entityId: own.entity.id,
      entityMemberId: member.id,
      storeId: store.id,
      addedByMemberId: own.owner.id,
    });
    return { user, member };
  }
  const first = await clerk();
  return { own, store, manager, ctx, first, clerk };
}
type World = Awaited<ReturnType<typeof world>>;
async function archive(w: World) {
  const before = await prisma.outboxEvent.findFirst({
    where: { entityId: w.own.entity.id },
    orderBy: { seq: "desc" },
  });
  await tenant.archiveStore(w.ctx, { storeId: w.store.id });
  return prisma.outboxEvent.findMany({
    where: { entityId: w.own.entity.id, ...(before ? { seq: { gt: before.seq } } : {}) },
    orderBy: { seq: "asc" },
  });
}
async function consume(id: string) {
  while ((await runtime.events.expand()).events > 0) {
    /* 完整展开真实出站投递。 */
  }
  if (!refs.has(id)) {
    const batch = await runtime.tx.run((tx) => claimDeliveries(tx));
    for (const ref of batch.claimed)
      if (ref.subscriber === "notify.onEvent") refs.set(ref.eventId, ref);
  }
  const ref = refs.get(id);
  if (!ref) throw new Error("没有已真实领取的 notify 投递");
  const deps = {
    tx: runtime.tx,
    clock,
    subscribers: runtime.events.subscribers,
    alerts: alertsOf(runtime.assembly),
  };
  expect(await consumeDelivery(deps, ref)).toBe("done");
  expect(await consumeDelivery(deps, ref)).toBe("stale");
}
async function notices(w: World) {
  const events = await prisma.outboxEvent.findMany({
    where: { entityId: w.own.entity.id },
    select: { id: true },
  });
  return prisma.notification.findMany({
    where: { sourceOutboxEventId: { in: events.map((e) => e.id) } },
    include: { merchantMessage: true, staffMessage: true },
    orderBy: { id: "asc" },
  });
}

describe("恢复再归档：真实当前发生次通知", { timeout: SLOW }, () => {
  it.each(["fixed", "advancing", "null_request"] as const)(
    "%s 多Clock/重复请求下旧源不借新归档发出",
    async (mode) => {
      const w = await world();
      const ctx =
        mode === "null_request"
          ? createIdentityContext({
              actor: w.ctx.actor,
              entityId: w.ctx.entityId,
              storeId: w.ctx.storeId,
            })
          : w.ctx;
      const current = { ...w, ctx };
      if (mode === "advancing") {
        const original = clock.now.bind(clock);
        vi.spyOn(clock, "now").mockImplementation(() => {
          const at = original();
          clock.advance(1);
          return at;
        });
      }
      const old = await archive(current);
      await tenant.restoreStore(ctx, { storeId: w.store.id });
      const second = await w.clerk();
      const fresh = await archive(current);
      vi.restoreAllMocks();
      expect(old.map((row) => row.requestId)).toEqual(fresh.map((row) => row.requestId));
      expect(fresh[0]!.seq).toBeGreaterThan(old.at(-1)!.seq);
      for (const event of old) await consume(event.id);
      expect(await notices(w)).toEqual([]);
      for (const event of fresh) await consume(event.id);
      const rows = await notices(w);
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.sourceOutboxEventId).sort()).toEqual(
        [fresh[0]!.id, fresh[1]!.id, fresh[1]!.id].sort(),
      );
      const personal = rows.find((row) => row.merchantUserId === second.user.id)!;
      expect(personal).toMatchObject({
        bizType: "merchant_user",
        bizId: second.user.id,
        entityId: null,
        storeId: null,
        copyMode: null,
        merchantMessage: { isOwnerOnly: false, link: { route: "messages.list", params: {} } },
      });
      const safe = JSON.stringify({ vars: personal.vars, body: personal.merchantMessage?.body });
      for (const privateValue of [
        w.own.entity.id,
        w.store.id,
        second.user.displayName,
        second.user.phoneMask,
      ])
        expect(safe).not.toContain(privateValue);
      expect(rows.some((row) => row.merchantUserId === w.first.user.id)).toBe(false);
      expect(rows.find((row) => row.staffId === w.manager.id)?.bizId).toBe(w.store.id);
    },
  );

  it("第二次归档无新移除时，旧个人/老板源仍0，当前经理源独立发送", async () => {
    const w = await world(),
      old = await archive(w);
    await tenant.restoreStore(w.ctx, { storeId: w.store.id });
    const fresh = await archive(w);
    expect(fresh.map((row) => row.eventType)).toEqual(["store.archived"]);
    for (const event of [...old, ...fresh]) await consume(event.id);
    expect(await notices(w)).toMatchObject([
      { staffId: w.manager.id, sourceOutboxEventId: fresh[0]!.id },
    ]);
    expect(await prisma.merchantMessage.count({ where: { merchantUserId: w.first.user.id } })).toBe(
      0,
    );
  });

  it("旧通知已派发但未外发，恢复/再归档后Provider前取消；当前源仍真实外发", async () => {
    const w = await world(),
      old = await archive(w);
    await consume(old[0]!.id);
    const firstNotice = (await notices(w))[0]!;
    const oldDelivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: firstNotice.id, channel: "wecom" },
    });
    await tenant.restoreStore(w.ctx, { storeId: w.store.id });
    const fresh = await archive(w);
    const calls = providers.wecom.calls.length;
    await runtime.notify.deliver({ deliveryId: oldDelivery.id });
    expect(providers.wecom.calls).toHaveLength(calls);
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: oldDelivery.id } }),
    ).toMatchObject({ status: "cancelled", callStartedAt: null });
    await consume(fresh[0]!.id);
    const freshNotice = (await notices(w)).find((row) => row.sourceOutboxEventId === fresh[0]!.id)!;
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: freshNotice.id, channel: "wecom" },
    });
    await runtime.notify.deliver({ deliveryId: delivery.id });
    expect(providers.wecom.calls).toHaveLength(calls + 1);
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: "sent" });
    expect(await prisma.notification.findUnique({ where: { id: firstNotice.id } })).not.toBeNull();
  });

  it.each(["archive_actor", "archive_time", "removed_time", "entity_closed"] as const)(
    "%s 当前五列或迁移归属不匹配则拒发",
    async (mode) => {
      const w = await world(),
        events = await archive(w);
      if (mode === "archive_actor")
        await prisma.store.update({
          where: { id: w.store.id },
          data: { archiveActorId: (await make.merchantUser()).id },
        });
      if (mode === "archive_time")
        await prisma.store.update({
          where: { id: w.store.id },
          data: { archivedAt: new Date(clock.now().getTime() + 1) },
        });
      if (mode === "removed_time")
        await prisma.entityMember.update({
          where: { id: w.first.member.id },
          data: { removedAt: new Date(clock.now().getTime() + 1) },
        });
      if (mode === "entity_closed")
        await prisma.entity.update({
          where: { id: w.own.entity.id },
          data: { lifecycle: "closed", closedAt: clock.now() },
        });
      for (const event of events) await consume(event.id);
      expect((await notices(w)).map((row) => row.staffId)).toEqual(
        mode === "removed_time" ? [w.manager.id] : [],
      );
    },
  );

  it("同发生次Clock回拨不虚造单调时间，保守0通知", async () => {
    const w = await world();
    const original = runtime.flow.transition.bind(runtime.flow);
    vi.spyOn(runtime.flow, "transition").mockImplementationOnce(async (...args) => {
      clock.advance(-1);
      return original(...args);
    });
    const events = await archive(w);
    vi.restoreAllMocks();
    const store = await prisma.store.findUniqueOrThrow({ where: { id: w.store.id } });
    const history = await prisma.statusTransition.findFirstOrThrow({
      where: { subjectId: w.store.id, event: "store.archive" },
    });
    expect(history.occurredAt.getTime()).toBeLessThan(store.archivedAt!.getTime());
    for (const event of events) await consume(event.id);
    expect(await notices(w)).toEqual([]);
  });

  it("新发生次派发失败仍同事务回滚，重试不重复旧消息", async () => {
    const w = await world(),
      old = await archive(w);
    for (const event of old) await consume(event.id);
    const oldRows = await notices(w);
    await tenant.restoreStore(w.ctx, { storeId: w.store.id });
    await w.clerk();
    const fresh = await archive(w);
    const tables = ["notification", "notification_delivery", "merchant_message", "staff_message"];
    const before = await snapshotTables(prisma, tables),
      failure = new Error("当前发生次通知回滚");
    await expect(
      runtime.tx.run(async (tx) => {
        for (const event of fresh)
          await runtime.notify.onEvent(tx, {
            id: event.id,
            type: event.eventType,
            payload: event.payload as Record<string, unknown>,
          });
        expect(
          await tx.notification.count({
            where: { sourceOutboxEventId: { in: fresh.map((event) => event.id) } },
          }),
        ).toBe(3);
        throw failure;
      }),
    ).rejects.toThrow(failure);
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    for (const event of fresh) await consume(event.id);
    const rows = await notices(w);
    expect(rows).toHaveLength(oldRows.length + 3);
    for (const oldRow of oldRows) expect(rows.find((row) => row.id === oldRow.id)).toEqual(oldRow);
  });
});
