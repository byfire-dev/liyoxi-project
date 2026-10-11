import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, loadEnv } from "../index.js";
import { createDocs } from "../docs/index.js";
import { createIdentity, assertCurrentSession, currentSessionOpenid } from "../identity/index.js";
import { createTenant } from "../tenant/index.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import {
  AppError,
  alertsOf,
  createIdentityContext,
  createIdempotencyContext,
  createTxRunner,
  uuidv7,
} from "../kernel/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";

const SLOW = 120_000,
  APPID = "wxlyxtest00000001";
const db = useSeededDatabase("services"),
  redis = useTestRedis(),
  clock = createClock();
const providers = createFakeProviders({ clock });
let runtime: ReturnType<typeof createRuntime>, tenant: ReturnType<typeof createTenant>;
let identity: ReturnType<typeof createIdentity>, prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let versions: { agreementKey: string; id: string }[];
const meta = {
  requestId: "req_inv_accept",
  ip: "203.0.113.56",
  userAgent: "公开运行时测试",
  clientVersion: null,
};
const ctx = (userId: string, entityId?: string, storeId?: string) =>
  createIdentityContext({
    actor: { type: "merchant", id: userId, client: "weapp" },
    ...(entityId ? { entityId } : {}),
    ...(storeId ? { storeId } : {}),
  });
beforeAll(async () => {
  prisma = await db.prisma();
  await redis.raw();
  runtime = createRuntime({
    entry: "api",
    version: "fictional-invitation-accept",
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
  versions = await Promise.all(
    ["user", "privacy"].map(
      async (agreementKey) =>
        (await prisma.agreementVersion.findFirst({ where: { agreementKey, status: "active" } })) ??
        make.agreementVersion({ agreementKey }),
    ),
  );
  tenant = createTenant({
    tx: runtime.tx,
    clock,
    flow: runtime.flow,
    assembly: runtime.assembly,
    events: runtime.events,
    invitations: {
      keyring: () => TEST_KEYRING,
      timers: runtime.timers,
      checkRemark: async () => {},
      accept: {
        assertSession: (tx, principal, now) => assertCurrentSession(tx, principal, now, APPID),
        async checkName(principal, content) {
          const openid = await runtime.tx.run((tx) => currentSessionOpenid(tx, principal, APPID));
          const result = await providers.wechat.checkText({ openid, scene: "profile", content });
          if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
          if (result.value.verdict !== "pass") throw new AppError("CONTENT_REJECTED");
        },
      },
    },
  });
  identity = createIdentity({
    tx: runtime.tx,
    clock,
    flow: runtime.flow,
    assembly: runtime.assembly,
    events: runtime.events,
    tenant,
    docs: createDocs({ tx: runtime.tx, clock }),
    config: runtime.config,
    keyring: () => TEST_KEYRING,
    wechat: providers.wechat,
    appid: APPID,
  });
}, SLOW);
afterAll(async () => {
  await runtime?.close();
}, SLOW);
async function person() {
  const id = uuidv7(),
    phone = `139${String(++serial).padStart(8, "0")}`;
  providers.wechat.sessions.set(id, { openid: `fictional_${id}` });
  providers.wechat.phones.set(id, phone);
  const login = await identity.phoneLogin(meta, {
    loginCode: id,
    phoneCode: id,
    consents: versions.map((v) => ({ agreementKey: v.agreementKey, agreementVersionId: v.id })),
  });
  const auth = await identity.authenticate(login.token, { ip: meta.ip });
  if (!auth.ok) throw new Error("真实运行时会话未成立");
  await prisma.merchantUser.update({
    where: { id: auth.principal.merchantUserId },
    data: { displayName: "公开店员" },
  });
  return {
    principal: auth.principal,
    ctx: ctx(auth.principal.merchantUserId),
    id: auth.principal.merchantUserId,
  };
}
let serial = 82_000_000;
async function world() {
  const owner = await person(),
    user = await person(),
    created = await tenant.createEntity(owner.ctx);
  const ownerCtx = ctx(owner.id, created.entityId, created.storeId);
  const card = await tenant.createInvitation(ownerCtx, { clientRequestId: uuidv7() });
  return { owner, user, ownerCtx, card, ...created };
}
type World = Awaited<ReturnType<typeof world>>;
async function accept(w: World) {
  const body = { token: w.card.token };
  return tenant.acceptInvitation(
    w.user.ctx,
    { invitationId: w.card.invitationId, ...body },
    {
      principal: w.user.principal,
      idem: createIdempotencyContext({
        mode: "required",
        scope: "m.invitation.accept",
        actor: w.user.ctx.actor,
        key: uuidv7(),
        request: {
          method: "POST",
          pathParams: { invitationId: w.card.invitationId },
          body,
          storeId: null,
        },
      }),
    },
  );
}
async function claim(eventId: string) {
  while ((await runtime.events.expand()).events > 0) {
    /* 真实展开出站事件。 */
  }
  const batch = await runtime.tx.run((tx) => claimDeliveries(tx));
  const ref = batch.claimed.find(
    (row) => row.eventId === eventId && row.subscriber === "notify.onEvent",
  );
  if (!ref) throw new Error("真实事件未形成通知投递");
  return ref;
}
const consume = (ref: Parameters<typeof consumeDelivery>[1]) =>
  consumeDelivery(
    { tx: runtime.tx, subscribers: runtime.events.subscribers, alerts: alertsOf(runtime.assembly) },
    ref,
  );
const eventOf = (id: string) =>
  prisma.outboxEvent.findFirstOrThrow({
    where: {
      aggregateId: id,
      eventType: { in: ["entity_member.joined", "entity_member.stores_changed"] },
    },
    orderBy: { seq: "desc" },
  });
const messages = (id: string) =>
  prisma.merchantMessage.findMany({
    where: { notification: { bizType: "invitation", bizId: id } },
  });

describe("接受邀请真实装配、出站消费与当前老板通知", { timeout: SLOW }, () => {
  it("真实 joined 只通知当前老板，持久邀请分流且重投唯一；不同邀请分别通知", async () => {
    const w = await world(),
      result = await accept(w),
      event = await eventOf(result.memberId);
    const ref = await claim(event.id);
    expect(await consume(ref)).toBe("done");
    expect(await consume(ref)).toBe("stale");
    const list = await messages(w.card.invitationId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      merchantUserId: w.owner.id,
      entityId: w.entityId,
      storeId: w.storeId,
      isOwnerOnly: true,
      link: { route: "store.members", params: { storeId: w.storeId } },
    });
    expect(list[0]!.body).toContain("公开店员");
    expect(list[0]!.body).not.toContain("139820000");
    await runtime.tx.run((tx) =>
      runtime.notify.onEvent(tx, {
        id: event.id,
        type: event.eventType,
        payload: event.payload as Record<string, unknown>,
      }),
    );
    expect(await messages(w.card.invitationId)).toEqual(list);
    const other = await person(),
      card = await tenant.createInvitation(w.ownerCtx, { clientRequestId: uuidv7() });
    const second = await accept({ ...w, user: other, card });
    expect(await consume(await claim((await eventOf(second.memberId)).id))).toBe("done");
    expect(await messages(card.invitationId)).toHaveLength(1);
    expect(providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
  });
  it("真实已有店员接受新店产生带invitationId范围事件，原null范围通知仍只给店员", async () => {
    const w = await world(),
      first = await accept(w);
    const store = await make.store({ entityId: w.entityId });
    const card = await tenant.createInvitation(ctx(w.owner.id, w.entityId, store.id), {
      clientRequestId: uuidv7(),
    });
    const next = await accept({ ...w, card });
    expect(next.memberId).toBe(first.memberId);
    expect(next.isNew).toBe(false);
    const invited = await eventOf(first.memberId);
    expect(invited.payload).toMatchObject({
      invitationId: card.invitationId,
      addedStoreIds: [store.id],
    });
    expect(await consume(await claim(invited.id))).toBe("done");
    expect((await messages(card.invitationId)).map((row) => row.merchantUserId)).toEqual([
      w.owner.id,
    ]);
    await tenant.updateMember(w.ownerCtx, { memberId: first.memberId, storeIds: [store.id] });
    const plain = await eventOf(first.memberId);
    expect(plain.payload).toMatchObject({ invitationId: null });
    expect(await consume(await claim(plain.id))).toBe("done");
    const ordinary = await prisma.merchantMessage.findMany({
      where: { notification: { bizType: "entity_member", bizId: first.memberId } },
    });
    expect(ordinary.map((row) => row.merchantUserId)).toEqual([w.user.id]);
    expect(ordinary[0]!.isOwnerOnly).toBe(false);
  });
  it.each(["removed", "ownerDisabled", "archived"] as const)(
    "消费前%s不沿旧角色/事件快照发出通知",
    async (mode) => {
      const w = await world(),
        result = await accept(w),
        event = await eventOf(result.memberId);
      if (mode === "removed") await tenant.leaveMembership(ctx(w.user.id, w.entityId, w.storeId));
      else if (mode === "ownerDisabled")
        await prisma.merchantUser.update({
          where: { id: w.owner.id },
          data: { status: "disabled" },
        });
      else
        await prisma.store.update({
          where: { id: w.storeId },
          data: {
            lifecycle: "archived",
            archivedAt: clock.now(),
            archiveReason: "by_owner",
            archiveActorType: "merchant",
            archiveActorId: w.owner.id,
            archiveClient: "weapp",
          },
        });
      expect(await consume(await claim(event.id))).toBe("done");
      expect(await messages(w.card.invitationId)).toEqual([]);
    },
  );
  it("延迟发送与真实未触达沿持久 invitation 分支复查，老板失效不发外部通知", async () => {
    const original = await prisma.notifyScene.findUniqueOrThrow({
      where: { sceneKey: "m.member_changed" },
    });
    const saved = clock.now();
    await prisma.notifyScene.update({
      where: { sceneKey: original.sceneKey },
      data: {
        extEnabled: true,
        smsPolicy: "fallback",
        smsTemplateKey: "generic_todo",
        managerEscalationEnabled: true,
      },
    });
    try {
      const w = await world(),
        manager = await make.staff();
      await prisma.store.update({
        where: { id: w.storeId },
        data: { deliveryManagerId: manager.id },
      });
      const joined = await accept(w);
      expect(await consume(await claim((await eventOf(joined.memberId)).id))).toBe("done");
      const notice = await prisma.notification.findFirstOrThrow({
        where: { bizType: "invitation", bizId: w.card.invitationId },
      });
      const wx = await prisma.notificationDelivery.findFirstOrThrow({
        where: { notificationId: notice.id, channel: "wx_subscribe" },
      });
      await runtime.notify.deliver({ deliveryId: wx.id });
      // 没有订阅额度/实际配置，不编造外部受理；正式fallback仍沿真实接受事实。
      expect(
        (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: wx.id } })).status,
      ).toBe("skipped");
      const sms = await prisma.notificationDelivery.findFirstOrThrow({
        where: { notificationId: notice.id, channel: "sms" },
      });
      clock.set(new Date(Math.max(clock.now().getTime(), sms.dueAt.getTime())));
      providers.sms.failNext("sendSubscribeFallback");
      await runtime.notify.deliver({ deliveryId: sms.id });
      const escalation = await prisma.notification.findFirstOrThrow({
        where: { bizId: notice.id, notifySceneKey: "s.merchant_unreached" },
      });
      expect(escalation).toMatchObject({
        staffId: manager.id,
        entityId: w.entityId,
        storeId: w.storeId,
      });
      expect(escalation.vars).toMatchObject({
        guardBizType: "invitation",
        guardBizId: w.card.invitationId,
      });
      expect(await prisma.staffMessage.count({ where: { notificationId: escalation.id } })).toBe(1);
      clock.set(saved);
      const late = await world(),
        member = await accept(late);
      expect(await consume(await claim((await eventOf(member.memberId)).id))).toBe("done");
      const pending = await prisma.notificationDelivery.findFirstOrThrow({
        where: {
          notification: { bizType: "invitation", bizId: late.card.invitationId },
          channel: "wx_subscribe",
        },
      });
      const calls = providers.wechat.callsOf("sendSubscribeMessage").length;
      await prisma.merchantUser.update({
        where: { id: late.owner.id },
        data: { status: "disabled" },
      });
      await runtime.notify.deliver({ deliveryId: pending.id });
      expect(
        await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({ status: "cancelled", reason: "guard_invalid", callStartedAt: null });
      expect(providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(calls);
      expect(
        await prisma.notification.count({
          where: { bizId: pending.notificationId!, notifySceneKey: "s.merchant_unreached" },
        }),
      ).toBe(0);
    } finally {
      clock.set(saved);
      await prisma.notifyScene.update({
        where: { sceneKey: original.sceneKey },
        data: {
          extEnabled: original.extEnabled,
          smsPolicy: original.smsPolicy,
          smsTemplateKey: original.smsTemplateKey,
          managerEscalationEnabled: original.managerEscalationEnabled,
        },
      });
    }
  });
  it("通知故障真实回滚，原投递retry且业务接受不伪回滚；关闭 scoped handler拒绝后续消费", async () => {
    const w = await world(),
      result = await accept(w),
      event = await eventOf(result.memberId),
      ref = await claim(event.id);
    const tables = ["notification", "merchant_message", "notification_delivery"],
      before = await snapshotTables(prisma, tables);
    const real = runtime.notify.onEvent.bind(runtime.notify);
    const fault = vi.spyOn(runtime.notify, "onEvent").mockImplementation(async (tx, input) => {
      await real(tx, input);
      throw new Error("公开通知故障");
    });
    try {
      expect(await consume(ref)).toBe("retry");
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(
        (await prisma.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } })).status,
      ).toBe("accepted");
    } finally {
      fault.mockRestore();
    }
    await runtime.close();
    const subscriber = runtime.assembly.subscriber("notify.onEvent")!;
    await expect(
      createTxRunner({ prisma, appEnv: "test" }).run((tx) =>
        subscriber.handle(tx, {
          id: event.id,
          type: event.eventType,
          payload: event.payload as Record<string, unknown>,
        }),
      ),
    ).rejects.toThrow("已经关闭");
  });
});
