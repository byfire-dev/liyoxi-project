import { MessageListQuerySchema } from "@liyoxi/contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, createTenant, loadEnv, readStoreDraftFacts } from "../index.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import {
  alertsOf,
  createIdempotencyContext,
  createIdentityContext,
  uuidv7,
} from "../kernel/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createNotifyMessages } from "./index.js";

const SLOW = 120_000,
  db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
const clock = createClock(),
  providers = createFakeProviders({ clock }),
  refs = new Map<string, DeliveryRef>();
let runtime: ReturnType<typeof createRuntime>, tenant: ReturnType<typeof createTenant>;
let prisma: Awaited<ReturnType<typeof db.prisma>>, make: ReturnType<typeof createFactories>;
beforeEach(() => refs.clear());
beforeAll(async () => {
  prisma = await db.prisma();
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "lyxtest-store-delete-notify",
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
  tenant = createTenant({ ...runtime, clock, archiveTimers: runtime.timers, readStoreDraftFacts });
}, SLOW);
afterAll(async () => {
  await runtime?.close();
}, SLOW);
async function world() {
  const own = await make.merchant({ verified: true }),
    store = await make.store({ entityId: own.entity.id });
  const manager = await make.staff({
    wecomBindStatus: "bound",
    wecomUserid: `delete-${uuidv7()}`,
    wecomBoundAt: clock.now(),
  });
  await prisma.store.update({ where: { id: store.id }, data: { deliveryManagerId: manager.id } });
  const user = await make.merchantUser({ displayName: "不可泄漏的店员姓名" });
  const member = await make.entityMember({
    entityId: own.entity.id,
    merchantUserId: user.id,
    invitedByMemberId: own.owner.id,
    lastStoreId: store.id,
  });
  await make.storeMember({
    entityId: own.entity.id,
    entityMemberId: member.id,
    storeId: store.id,
    addedByMemberId: own.owner.id,
  });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: own.user.id, client: "weapp" },
    entityId: own.entity.id,
    storeId: own.store.id,
    requestId: "req_delete_notify_repeated",
  });
  return { own, store, manager, user, member, ctx };
}
type World = Awaited<ReturnType<typeof world>>;
async function remove(w: World) {
  await tenant.deleteStore(
    w.ctx,
    { storeId: w.store.id },
    {
      idem: createIdempotencyContext({
        mode: "required",
        scope: "m.store.delete",
        actor: w.ctx.actor,
        key: uuidv7(),
        request: {
          method: "POST",
          pathParams: { storeId: w.store.id },
          body: null,
          storeId: w.ctx.storeId,
        },
      }),
    },
  );
  return prisma.outboxEvent.findMany({
    where: { entityId: w.own.entity.id },
    orderBy: { seq: "asc" },
  });
}
async function consume(id: string) {
  while ((await runtime.events.expand()).events > 0) {
    /* 真实 outbox 展开。 */
  }
  const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  if (
    !runtime.events.subscribers
      .forEvent(event.eventType)
      .some((item) => item.name === "notify.onEvent")
  ) {
    expect(
      await prisma.outboxDelivery.count({
        where: { outboxEventId: id, subscriber: "notify.onEvent" },
      }),
    ).toBe(0);
    await runtime.tx.run((tx) =>
      runtime.notify.onEvent(tx, {
        id,
        type: event.eventType,
        payload: event.payload as Record<string, unknown>,
      }),
    );
    return;
  }
  if (!refs.has(id)) {
    const batch = await runtime.tx.run((tx) => claimDeliveries(tx));
    for (const ref of batch.claimed)
      if (ref.subscriber === "notify.onEvent") refs.set(ref.eventId, ref);
  }
  const ref = refs.get(id);
  if (!ref) throw new Error("没有真实 notify 投递");
  const deps = {
    tx: runtime.tx,
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
async function managerZero(w: World) {
  expect(await prisma.staffMessage.count({ where: { staffId: w.manager.id } })).toBe(0);
  expect(await prisma.notification.count({ where: { staffId: w.manager.id } })).toBe(0);
  expect(
    await prisma.notificationDelivery.count({ where: { notification: { staffId: w.manager.id } } }),
  ).toBe(0);
  expect(
    providers.wecom.calls.filter((call) => JSON.stringify(call).includes(w.manager.wecomUserid!)),
  ).toEqual([]);
}

describe("草稿删除通知：真实发生次、账号安全投影与经理零通知", { timeout: SLOW }, () => {
  it("本人账号消息无范围/业务隐私，老板跳仍有效店，经理全链零投递", async () => {
    const w = await world(),
      events = await remove(w);
    expect(events.map((e) => e.eventType)).toEqual([
      "store.archived",
      "entity_member.removed",
      "store.draft_deleted",
    ]);
    for (const event of events) await consume(event.id);
    const rows = await notices(w);
    expect(rows).toHaveLength(2);
    const personal = rows.find((n) => n.merchantUserId === w.user.id)!;
    expect(personal).toMatchObject({
      notifySceneKey: "m.member_changed",
      bizType: "merchant_user",
      bizId: w.user.id,
      entityId: null,
      storeId: null,
      copyMode: null,
      merchantMessage: { isOwnerOnly: false, link: { route: "messages.list", params: {} } },
    });
    const safe = JSON.stringify({
      vars: personal.vars,
      title: personal.merchantMessage?.title,
      body: personal.merchantMessage?.body,
    });
    for (const value of [w.own.entity.id, w.store.id, w.user.displayName!, w.user.phoneMask])
      expect(safe).not.toContain(value);
    expect(rows.find((n) => n.merchantUserId === w.own.user.id)).toMatchObject({
      entityId: w.own.entity.id,
      storeId: w.own.store.id,
      merchantMessage: {
        isOwnerOnly: true,
        link: { route: "store.members", params: { storeId: w.own.store.id } },
      },
    });
    for (const row of rows) expect(row.dedupeKey).toContain(row.sourceOutboxEventId);
    const service = createNotifyMessages({
      tx: runtime.tx,
      clock,
      config: runtime.config,
      purchaseMode: async () => "in_app",
    });
    const list = await service.list(
      { merchantUserId: w.user.id, storeId: null },
      MessageListQuerySchema.parse({}),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.messageId).toBe(personal.merchantMessage?.id);
    await expect(
      service.list(
        { merchantUserId: w.user.id, storeId: w.store.id },
        MessageListQuerySchema.parse({}),
      ),
    ).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
    const another = await make.merchantUser();
    expect(
      (
        await service.list(
          { merchantUserId: another.id, storeId: null },
          MessageListQuerySchema.parse({}),
        )
      ).items,
    ).toEqual([]);
    const before = await snapshotTables(prisma, [
      "notification",
      "merchant_message",
      "staff_message",
      "notification_delivery",
    ]);
    for (const event of events)
      await runtime.tx.run((tx) =>
        runtime.notify.onEvent(tx, {
          id: event.id,
          type: event.eventType,
          payload: event.payload as Record<string, unknown>,
        }),
      );
    expect(await snapshotTables(prisma, Object.keys(before))).toEqual(before);
    await managerZero(w);
  });

  it.each(["user_disabled", "owner_disabled", "manager_disabled", "no_manager"] as const)(
    "%s 使用实际收件人状态，无经理兜底",
    async (mode) => {
      const w = await world(),
        events = await remove(w);
      if (mode === "user_disabled" || mode === "owner_disabled")
        await prisma.merchantUser.update({
          where: { id: mode === "user_disabled" ? w.user.id : w.own.user.id },
          data: { status: "disabled" },
        });
      if (mode === "manager_disabled")
        await prisma.staff.update({
          where: { id: w.manager.id },
          data: { status: "disabled", disabledAt: clock.now(), disabledReason: "other" },
        });
      if (mode === "no_manager")
        await prisma.store.update({ where: { id: w.store.id }, data: { deliveryManagerId: null } });
      for (const event of events) await consume(event.id);
      const rows = await notices(w);
      expect(rows).toHaveLength(mode === "user_disabled" || mode === "owner_disabled" ? 1 : 2);
      if (mode === "user_disabled")
        expect(rows.some((r) => r.merchantUserId === w.user.id)).toBe(false);
      if (mode === "owner_disabled")
        expect(rows.some((r) => r.merchantUserId === w.own.user.id)).toBe(false);
      await managerZero(w);
    },
  );

  it("archive→restore→delete 旧source不借当前发生次；同 request/Clock 不当唯一键", async () => {
    const w = await world();
    await prisma.entity.update({ where: { id: w.own.entity.id }, data: { storeLimitOverride: 2 } });
    await tenant.archiveStore(w.ctx, { storeId: w.store.id });
    const old = await prisma.outboxEvent.findMany({
      where: { entityId: w.own.entity.id },
      orderBy: { seq: "asc" },
    });
    await tenant.restoreStore(w.ctx, { storeId: w.store.id });
    const user = await make.merchantUser(),
      member = await make.entityMember({
        entityId: w.own.entity.id,
        merchantUserId: user.id,
        invitedByMemberId: w.own.owner.id,
      });
    await make.storeMember({
      entityId: w.own.entity.id,
      entityMemberId: member.id,
      storeId: w.store.id,
      addedByMemberId: w.own.owner.id,
    });
    const all = await remove(w),
      fresh = all.filter((row) => row.seq > old.at(-1)!.seq);
    for (const event of old) await consume(event.id);
    expect(await notices(w)).toEqual([]);
    for (const event of fresh) await consume(event.id);
    expect((await notices(w)).map((r) => r.merchantUserId).sort()).toEqual(
      [user.id, w.own.user.id].sort(),
    );
    await managerZero(w);
  });

  it("既已派发的旧经理通知发送前重验当前 draft_deleted 并取消，Provider零调用", async () => {
    const w = await world();
    await prisma.notifyScene.update({
      where: { sceneKey: "s.merchant_changed" },
      data: { sendWindow: "immediate" },
    });
    await prisma.entity.update({ where: { id: w.own.entity.id }, data: { storeLimitOverride: 2 } });
    await tenant.archiveStore(w.ctx, { storeId: w.store.id });
    const archived = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: w.store.id, eventType: "store.archived" },
    });
    await consume(archived.id);
    const notice = await prisma.notification.findFirstOrThrow({
      where: { sourceOutboxEventId: archived.id, staffId: w.manager.id },
    });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: notice.id, channel: "wecom" },
    });
    await tenant.restoreStore(w.ctx, { storeId: w.store.id });
    await remove(w);
    const calls = providers.wecom.calls.length;
    await runtime.notify.deliver({ deliveryId: delivery.id });
    expect(providers.wecom.calls).toHaveLength(calls);
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: "cancelled" });
  });

  it("原真实 dispatch 后抛错，通知/消息/投递一起回滚，原claim可随后真消费", async () => {
    const w = await world(),
      events = await remove(w),
      before = await snapshotTables(prisma, [
        "notification",
        "merchant_message",
        "staff_message",
        "notification_delivery",
      ]);
    const failure = new Error("真实删除告知事务回滚");
    await expect(
      runtime.tx.run(async (tx) => {
        for (const event of events)
          await runtime.notify.onEvent(tx, {
            id: event.id,
            type: event.eventType,
            payload: event.payload as Record<string, unknown>,
          });
        expect(
          await tx.notification.count({
            where: { sourceOutboxEventId: { in: events.map((event) => event.id) } },
          }),
        ).toBe(2);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await snapshotTables(prisma, Object.keys(before))).toEqual(before);
    for (const event of events) await consume(event.id);
    expect(await notices(w)).toHaveLength(2);
    await managerZero(w);
  });
});
