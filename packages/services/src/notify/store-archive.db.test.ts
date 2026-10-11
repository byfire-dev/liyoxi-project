import { MessageListQuerySchema } from "@liyoxi/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, createTenant, loadEnv } from "../index.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
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
import { createNotifyMessages } from "./index.js";

const SLOW = 120_000;
const db = useSeededDatabase("services", { max: 1 });
const redis = useTestRedis(),
  clock = createClock(),
  providers = createFakeProviders({ clock });
let runtime: ReturnType<typeof createRuntime>;
let tenant: ReturnType<typeof createTenant>;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
beforeAll(async () => {
  prisma = await db.prisma();
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "lyxtest-store-archive",
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
  tenant = createTenant({
    tx: runtime.tx,
    clock,
    flow: runtime.flow,
    assembly: runtime.assembly,
    events: runtime.events,
    archiveTimers: runtime.timers,
  });
}, SLOW);
afterAll(async () => {
  await runtime?.close();
}, SLOW);
async function world() {
  const own = await make.merchant({ verified: true });
  const second = await make.store({ entityId: own.entity.id });
  const third = await make.store({ entityId: own.entity.id });
  await prisma.entityMember.update({
    where: { id: own.owner.id },
    data: { lastStoreId: third.id },
  });
  const manager = await make.staff({
    wecomBindStatus: "bound",
    wecomUserid: `archive-${uuidv7()}`,
    wecomBoundAt: clock.now(),
  });
  await prisma.store.update({ where: { id: second.id }, data: { deliveryManagerId: manager.id } });
  const user = await make.merchantUser({ displayName: "私密店员称呼" });
  const member = await make.entityMember({
    entityId: own.entity.id,
    merchantUserId: user.id,
    invitedByMemberId: own.owner.id,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: second.id,
    addedByMemberId: own.owner.id,
  });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: own.user.id, client: "weapp" },
    entityId: own.entity.id,
    storeId: own.store.id,
    requestId: `req_archive_notify_${uuidv7()}`,
  });
  return { own, second, third, manager, user, member, ctx };
}
type World = Awaited<ReturnType<typeof world>>;
async function archived(w: World) {
  await tenant.archiveStore(w.ctx, { storeId: w.second.id });
  return prisma.outboxEvent.findMany({
    where: { entityId: w.own.entity.id },
    orderBy: { seq: "asc" },
  });
}
async function consume(eventId: string) {
  while ((await runtime.events.expand()).events > 0) {
    /* 真实 outbox 展开。 */
  }
  const { claimed } = await runtime.tx.run((tx) => claimDeliveries(tx));
  const ref = claimed.find((r) => r.eventId === eventId && r.subscriber === "notify.onEvent");
  if (!ref) throw new Error("没有正式 notify 投递");
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
async function messages(w: World) {
  const rows = await notices(w);
  return prisma.merchantMessage.findMany({
    where: { notificationId: { in: rows.map((n) => n.id) } },
    orderBy: { id: "asc" },
  });
}

describe("门店归档通知：实际来源、账号投影和发送前重验", { timeout: SLOW }, () => {
  it("本人账号告知无业务范围，老板跳当前有效店，经理走真实归档店详情；重投唯一", async () => {
    const w = await world(),
      events = await archived(w);
    expect(events.map((e) => e.eventType)).toEqual(["store.archived", "entity_member.removed"]);
    for (const event of events) await consume(event.id);
    const rows = await notices(w);
    expect(rows).toHaveLength(3);
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
    const encoded = JSON.stringify({
      vars: personal.vars,
      title: personal.merchantMessage?.title,
      body: personal.merchantMessage?.body,
    });
    expect(encoded).not.toContain("私密店员称呼");
    expect(encoded).not.toContain(w.own.entity.id);
    expect(encoded).not.toContain(w.second.id);
    expect(encoded).not.toContain(w.user.phoneMask);
    expect(rows.find((n) => n.merchantUserId === w.own.user.id)).toMatchObject({
      bizType: "entity_member",
      bizId: w.member.id,
      entityId: w.own.entity.id,
      storeId: w.third.id,
      merchantMessage: {
        isOwnerOnly: true,
        link: { route: "store.members", params: { storeId: w.third.id } },
      },
    });
    expect(rows.find((n) => n.staffId === w.manager.id)).toMatchObject({
      notifySceneKey: "s.merchant_changed",
      bizType: "store",
      bizId: w.second.id,
      entityId: w.own.entity.id,
      storeId: w.second.id,
      staffMessage: { link: { route: "merchant.detail", params: { entityId: w.own.entity.id } } },
    });
    for (const row of rows) expect(row.dedupeKey).toContain(row.sourceOutboxEventId);
    for (const event of events)
      await runtime.tx.run((tx) =>
        runtime.notify.onEvent(tx, {
          id: event.id,
          type: event.eventType,
          payload: event.payload as Record<string, unknown>,
        }),
      );
    expect(await notices(w)).toEqual(rows);
    expect(await messages(w)).toHaveLength(2);
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
    expect(list.items[0]?.messageId).toBe(
      (await messages(w)).find((m) => m.merchantUserId === w.user.id)?.id,
    );
    await expect(
      service.list(
        { merchantUserId: w.user.id, storeId: w.second.id },
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
  });

  it.each(["user_disabled", "manager_disabled", "owner_disabled", "no_manager"] as const)(
    "%s 不虚构收件人或跨范围兜底",
    async (mode) => {
      const w = await world(),
        events = await archived(w);
      if (mode === "user_disabled" || mode === "owner_disabled")
        await prisma.merchantUser.update({
          where: { id: mode === "user_disabled" ? w.user.id : w.own.user.id },
          data: { status: "disabled" },
        });
      if (mode === "manager_disabled")
        await prisma.staff.update({ where: { id: w.manager.id }, data: { status: "disabled" } });
      if (mode === "no_manager")
        await prisma.store.update({
          where: { id: w.second.id },
          data: { deliveryManagerId: null },
        });
      for (const event of events) await consume(event.id);
      const rows = await notices(w);
      expect(rows).toHaveLength(2);
      const absent =
        mode === "user_disabled"
          ? w.user.id
          : mode === "owner_disabled"
            ? w.own.user.id
            : w.manager.id;
      expect(rows.some((n) => n.merchantUserId === absent || n.staffId === absent)).toBe(false);
    },
  );

  it.each(["no_source", "wrong_payload"] as const)(
    "%s 不因伪 event/vars 取得账号级例外",
    async (mode) => {
      const w = await world(),
        events = await archived(w);
      const removed = events.find((e) => e.eventType === "entity_member.removed")!;
      const event = {
        id: mode === "no_source" ? uuidv7() : removed.id,
        type: removed.eventType,
        payload:
          mode === "wrong_payload"
            ? { ...(removed.payload as object), merchantUserId: w.own.user.id }
            : (removed.payload as Record<string, unknown>),
      };
      if (mode === "wrong_payload") {
        // 当前 reader 只认持久化真相，伪输入不能改收件人。
        await runtime.tx.run((tx) => runtime.notify.onEvent(tx, event));
        expect((await notices(w)).map((n) => n.merchantUserId).sort()).toEqual(
          [w.user.id, w.own.user.id].sort(),
        );
      } else {
        await runtime.tx.run((tx) => runtime.notify.onEvent(tx, event));
        expect(await notices(w)).toEqual([]);
      }
    },
  );

  it("只有合法终态前史而缺真实归档迁移历史时不产生告知", async () => {
    const w = await world();
    // 明示不完整来源反例，不 UPDATE/删除任何 append-only 历史证据。
    await prisma.store.update({
      where: { id: w.second.id },
      data: {
        lifecycle: "archived",
        archivedAt: clock.now(),
        archiveActorType: "merchant",
        archiveActorId: w.own.user.id,
        archiveClient: "weapp",
        archiveReason: "by_owner",
      },
    });
    await prisma.entityMember.update({
      where: { id: w.member.id },
      data: {
        status: "removed",
        removedAt: clock.now(),
        removeReason: "store_archived",
        removeActorType: "system",
        removeActorId: null,
        removeClient: null,
        lastStoreId: null,
      },
    });
    await prisma.storeMember.deleteMany({ where: { entityMemberId: w.member.id } });
    const eventId = await runtime.tx.run((tx) =>
      runtime.events.emit(
        tx,
        createIdentityContext({
          actor: { type: "system", job: "tenant.store.archive" },
          entityId: w.own.entity.id,
          storeId: w.second.id,
          requestId: w.ctx.requestId,
        }),
        {
          type: "entity_member.removed",
          aggregate: { type: "entity_member", id: w.member.id },
          payload: {
            v: 1,
            entityMemberId: w.member.id,
            entityId: w.own.entity.id,
            merchantUserId: w.user.id,
            role: "clerk",
            removeReason: "store_archived",
            fromState: "active",
            toState: "removed",
            transition: "entity_member.cascade_remove",
          },
        },
      ),
    );
    if (!eventId.id) throw new Error("缺少实际出站事件");
    await consume(eventId.id);
    expect(await notices(w)).toEqual([]);
  });

  it("by_owner 移除不借本片例外；原其他 removed 场景不扩大", async () => {
    const w = await world();
    await tenant.removeMember(w.ctx, { memberId: w.member.id });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: w.member.id, eventType: "entity_member.removed" },
    });
    await consume(event.id);
    expect(await notices(w)).toEqual([]);
    expect(await messages(w)).toEqual([]);
  });

  it("派发在真实调用方事务失败时连同通知、站内消息和通道投递全部回滚", async () => {
    const w = await world(),
      events = await archived(w);
    const before = await snapshotTables(prisma, [
      "notification",
      "merchant_message",
      "staff_message",
      "notification_delivery",
    ]);
    const failure = new Error("归档通知事务回滚");
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
        ).toBe(3);
        throw failure;
      }),
    ).rejects.toThrow(failure);
    expect(await snapshotTables(prisma, Object.keys(before))).toEqual(before);
    for (const event of events) await consume(event.id);
    expect(await notices(w)).toHaveLength(3);
  });

  it("真实经理已绑定且来源仍有效时，归档店通知可外发并保留固定安全投影", async () => {
    const w = await world(),
      events = await archived(w);
    await consume(events.find((event) => event.eventType === "store.archived")!.id);
    const n = (await notices(w)).find((row) => row.staffId === w.manager.id)!;
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: n.id, channel: "wecom" },
    });
    expect(delivery.dueAt.getTime()).toBeLessThanOrEqual(clock.now().getTime());
    const before = providers.wecom.calls.length;
    await runtime.notify.deliver({ deliveryId: delivery.id });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: "sent", callStartedAt: clock.now() });
    expect(providers.wecom.calls).toHaveLength(before + 1);
    const sent = JSON.stringify(providers.wecom.calls.at(-1));
    expect(sent).toContain("商家变动");
    expect(sent).not.toContain("私密店员称呼");
    expect(sent).not.toContain(w.user.phoneMask);
  });

  it.each(["source_missing", "source_other", "manager_disabled", "store_reason"] as const)(
    "delivery %s 在 Provider 前重新拒绝，零外发",
    async (mode) => {
      const w = await world(),
        events = await archived(w);
      await prisma.notifyScene.update({
        where: { sceneKey: "s.merchant_changed" },
        data: { sendWindow: "immediate" },
      });
      await consume(events.find((e) => e.eventType === "store.archived")!.id);
      const n = (await notices(w)).find((row) => row.staffId === w.manager.id)!;
      const delivery = await prisma.notificationDelivery.findFirstOrThrow({
        where: { notificationId: n.id, channel: "wecom" },
      });
      if (mode === "source_missing")
        await prisma.notification.update({
          where: { id: n.id },
          data: { sourceOutboxEventId: null },
        });
      if (mode === "source_other")
        await prisma.notification.update({
          where: { id: n.id },
          data: {
            sourceOutboxEventId: events.find(
              (event) => event.eventType === "entity_member.removed",
            )!.id,
          },
        });
      if (mode === "manager_disabled")
        await prisma.staff.update({ where: { id: w.manager.id }, data: { status: "disabled" } });
      if (mode === "store_reason")
        await prisma.store.update({
          where: { id: w.second.id },
          data: { archiveReason: "draft_deleted" },
        });
      const before = providers.wecom.calls.length;
      await runtime.notify.deliver({ deliveryId: delivery.id });
      expect(
        await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({ status: "cancelled", reason: "guard_invalid", callStartedAt: null });
      expect(providers.wecom.calls).toHaveLength(before);
    },
  );
});
