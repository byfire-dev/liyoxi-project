import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, createTenant, media, loadEnv } from "../index.js";
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

const db = useSeededDatabase("services", { max: 1 });
const redis = useTestRedis();
const clock = createClock();
const providers = createFakeProviders({ clock });
const SLOW = 120_000;
let runtime: ReturnType<typeof createRuntime>;
let tenant: ReturnType<typeof createTenant>;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
const context = (userId: string, entityId?: string, storeId?: string) =>
  createIdentityContext({
    actor: { type: "merchant", id: userId, client: "weapp" },
    ...(entityId ? { entityId } : {}),
    ...(storeId ? { storeId } : {}),
  });
beforeAll(async () => {
  prisma = await db.prisma();
  // 用公开运行时绑定真实notify subscriber、tenant keyed reader和fake外部能力。
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "fictional-member-stores",
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
    readMemberAssetCounts: media.readMemberAssetCounts,
  });
}, SLOW);
afterAll(async () => {
  await runtime?.close();
}, SLOW);

async function world() {
  const user = await make.merchantUser();
  const owner = await tenant.createEntity(context(user.id));
  const ctx = context(user.id, owner.entityId, owner.storeId);
  const second = await make.store({ entityId: owner.entityId });
  const third = await make.store({ entityId: owner.entityId });
  const clerk = await make.merchantUser();
  // 尚未交付邀请接受，只建立合法历史店员/门店关系；生产update发真实事件。
  const member = await make.entityMember({
    entityId: owner.entityId,
    merchantUserId: clerk.id,
    invitedByMemberId: owner.memberId,
    lastStoreId: owner.storeId,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: owner.storeId,
    addedByMemberId: owner.memberId,
  });
  const other = await make.merchantUser();
  const otherMember = await make.entityMember({
    entityId: owner.entityId,
    merchantUserId: other.id,
  });
  await make.storeMember({
    entityMemberId: otherMember.id,
    storeId: second.id,
    addedByMemberId: owner.memberId,
  });
  return { ...owner, user, clerk, member, ctx, second, third, other };
}
type World = Awaited<ReturnType<typeof world>>;
async function changed(w: World, ids = [w.second.id, w.third.id]) {
  await tenant.updateMember(w.ctx, { memberId: w.member.id, storeIds: ids });
  return prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: w.member.id, eventType: "entity_member.stores_changed" },
    orderBy: { seq: "desc" },
  });
}
async function claim(eventId: string) {
  while ((await runtime.events.expand()).events > 0) {
    /* 展开正式outbox，不手工伪造投递行。 */
  }
  const { claimed } = await runtime.tx.run((tx) => claimDeliveries(tx));
  const ref = claimed.find((row) => row.eventId === eventId && row.subscriber === "notify.onEvent");
  if (!ref) throw new Error("正式事件没有实际notify投递");
  return ref;
}
const consume = (ref: Parameters<typeof consumeDelivery>[1]) =>
  consumeDelivery(
    { tx: runtime.tx, subscribers: runtime.events.subscribers, alerts: alertsOf(runtime.assembly) },
    ref,
  );
const messages = (w: World) =>
  prisma.merchantMessage.findMany({
    where: { notification: { bizId: w.member.id } },
    orderBy: { createdAt: "asc" },
  });

describe("成员范围通知：真实outbox展开与消费", { timeout: SLOW }, () => {
  it("已移出旧店的目标仍收到新范围深链；重投唯一，第二次真实调整再次通知", async () => {
    const w = await world();
    const first = await changed(w);
    const ref = await claim(first.id);
    expect(await consume(ref)).toBe("done");
    expect(await consume(ref)).toBe("stale");
    await runtime.tx.run((tx) =>
      runtime.notify.onEvent(tx, {
        id: first.id,
        type: first.eventType,
        payload: first.payload as Record<string, unknown>,
      }),
    );
    const one = await messages(w);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      merchantUserId: w.clerk.id,
      entityId: w.entityId,
      storeId: w.second.id,
      isOwnerOnly: false,
      link: { route: "store.members", params: { storeId: w.second.id } },
    });
    expect(
      one.some((row) => row.merchantUserId === w.user.id || row.merchantUserId === w.other.id),
    ).toBe(false);
    const second = await changed(w, [w.third.id]);
    expect(second.id).not.toBe(first.id);
    expect(await consume(await claim(second.id))).toBe("done");
    const two = await messages(w);
    expect(two).toHaveLength(2);
    expect(two.map((row) => row.notificationId)).toHaveLength(
      new Set(two.map((row) => row.notificationId)).size,
    );
    expect(two.find((row) => row.storeId === w.third.id)?.link).toEqual({
      route: "store.members",
      params: { storeId: w.third.id },
    });
    expect(
      await prisma.notification.count({
        where: { bizId: w.member.id, notifySceneKey: "m.member_changed" },
      }),
    ).toBe(2);
    expect(providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
    expect(providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(0);
  });

  it("仍有效lastStore优先于稳定第一店，事实reader不沿事件旧店挑收件人", async () => {
    const w = await world();
    await make.storeMember({
      entityMemberId: w.member.id,
      storeId: w.second.id,
      addedByMemberId: w.memberId,
    });
    await prisma.entityMember.update({
      where: { id: w.member.id },
      data: { lastStoreId: w.second.id },
    });
    const event = await changed(w, [w.third.id, w.second.id, w.storeId]);
    expect(await consume(await claim(event.id))).toBe("done");
    expect((await messages(w))[0]).toMatchObject({
      storeId: w.second.id,
      link: { route: "store.members", params: { storeId: w.second.id } },
    });
  });

  it.each(["removed", "noActiveStore"] as const)(
    "消费时%s不再派发，不能凭事件快照放行",
    async (mode) => {
      const w = await world();
      const event = await changed(w, [w.second.id]);
      if (mode === "removed")
        await tenant.leaveMembership(context(w.clerk.id, w.entityId, w.second.id));
      else
        await prisma.store.update({
          where: { id: w.second.id },
          data: {
            lifecycle: "archived",
            archivedAt: clock.now(),
            archiveReason: "by_owner",
            archiveActorType: "merchant",
            archiveActorId: w.user.id,
            archiveClient: "weapp",
          },
        });
      expect(await consume(await claim(event.id))).toBe("done");
      expect(await messages(w)).toEqual([]);
      expect(await prisma.notification.count({ where: { bizId: w.member.id } })).toBe(0);
    },
  );

  it("真实消费故障回滚消息/notification/delivery，原outbox进入retry且未假称done", async () => {
    const w = await world();
    const event = await changed(w);
    const ref = await claim(event.id);
    const tables = ["notification", "merchant_message", "notification_delivery"];
    const before = await snapshotTables(prisma, tables);
    const real = runtime.notify.onEvent.bind(runtime.notify);
    const spy = vi.spyOn(runtime.notify, "onEvent").mockImplementation(async (tx, input) => {
      await real(tx, input);
      throw new Error("通知落库后真实事务故障");
    });
    try {
      expect(await consume(ref)).toBe("retry");
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(
        await prisma.outboxDelivery.findUniqueOrThrow({
          where: {
            outboxEventId_subscriber: { outboxEventId: event.id, subscriber: "notify.onEvent" },
          },
        }),
      ).toMatchObject({ status: "retry", attempts: 1, consumedAt: null });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["invitation", "wrongAccount", "wrongEntity", "unknownField"] as const)(
    "%s路径不误通知，strict payload及当前归属均重验",
    async (kind) => {
      const w = await world();
      const event = await changed(w);
      const payload = {
        ...(event.payload as Record<string, unknown>),
        ...(kind === "invitation"
          ? { invitationId: uuidv7() }
          : kind === "wrongAccount"
            ? { merchantUserId: w.other.id }
            : kind === "wrongEntity"
              ? { entityId: uuidv7() }
              : { role: "owner" }),
      };
      const before = await snapshotTables(prisma, [
        "notification",
        "merchant_message",
        "notification_delivery",
      ]);
      const request = runtime.tx.run((tx) =>
        runtime.notify.onEvent(tx, { id: event.id, type: event.eventType, payload }),
      );
      if (kind === "invitation") await expect(request).resolves.toBe(0);
      else await expect(request).rejects.toThrow();
      expect(
        await snapshotTables(prisma, ["notification", "merchant_message", "notification_delivery"]),
      ).toEqual(before);
    },
  );
});
