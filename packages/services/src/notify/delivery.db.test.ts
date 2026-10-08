import { createPrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import { seedWorkCalendar, useSeededDatabase } from "../testing/index.js";
import { createNotifyDispatcher } from "./service.js";
import { createWechatReceiptHandler } from "./wechat-receipts.js";
import { notificationFixture } from "./__fixtures__/dispatch.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
let other: ReturnType<typeof createPrismaClient>;
let service2: ReturnType<typeof createNotifyDispatcher>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
  other = createPrismaClient({ connectionString: await db.url(), max: 1 });
  service2 = createNotifyDispatcher({
    ...h.deps,
    tx: createTxRunner({ prisma: other, appEnv: "test" }),
  });
}, 120_000);
afterAll(async () => {
  await Promise.all([h?.service.close(), service2?.close()]);
  await other?.$disconnect();
});
const row = (id: string) => h.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });
async function staffDelivery() {
  const staff = await h.make.staff({
    wecomBindStatus: "bound",
    wecomUserid: `fictional-${uuidv7()}`,
    wecomBoundAt: h.clock.now(),
  });
  const ticket = await h.make.deliveryTicket({ deliveryManagerId: staff.id });
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.work_ticket_assigned" },
    data: { sendWindow: "immediate" },
  });
  await h.tx.run((tx) =>
    h.service.onEvent(tx, {
      id: uuidv7(),
      type: "ticket.assigned",
      payload: { v: 1, deliveryTicketId: ticket.id },
    }),
  );
  const delivery = await h.prisma.notificationDelivery.findFirstOrThrow({
    where: { channel: "wecom", notification: { bizId: ticket.id, staffId: staff.id } },
  });
  return { staff, delivery };
}
it("两独立连接认领同投递仅一实际Provider调用；TX外guard真实，额度扣一次", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  await Promise.all([
    h.service.deliver({ deliveryId: w.delivery.id }),
    service2.deliver({ deliveryId: w.delivery.id }),
  ]);
  expect(await row(w.delivery.id)).toMatchObject({ status: "sent", attemptNo: 1 });
  expect(
    h.providers.wechat.subscribeMessages.filter((v) => v.openid === w.identity.openid),
  ).toHaveLength(1);
  expect(
    await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: w.identity.id } }),
  ).toMatchObject({ estRemaining: 0 });
});
it("发送前老板降店员，当前ownerOnly守卫取消且不扣额度", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  await h.prisma.entityMember.update({ where: { id: own.owner.id }, data: { role: "clerk" } });
  await h.service.deliver({ deliveryId: w.delivery.id });
  expect(await row(w.delivery.id)).toMatchObject({
    status: "cancelled",
    reason: "guard_invalid",
    callStartedAt: null,
  });
});
it("未知结果不重发不返额度，明示未受理限流才按30秒重试", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  h.providers.wechat.failNext("sendSubscribeMessage");
  await h.service.deliver({ deliveryId: w.delivery.id });
  expect(await row(w.delivery.id)).toMatchObject({
    status: "failed",
    reason: "unknown_outcome",
    attemptNo: 1,
  });
  await h.service.deliver({ deliveryId: w.delivery.id });
  expect(
    h.providers.wechat
      .callsOf("sendSubscribeMessage")
      .filter((v) => (v.input as { openid: string }).openid === w.identity.openid),
  ).toHaveLength(1);
  expect(
    await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: w.identity.id } }),
  ).toMatchObject({ estRemaining: 0 });
  const next = await h.merchant(),
    retry = await h.wx(next);
  h.providers.wechat.failNotificationNext("sendSubscribeMessage", {
    acceptance: "not_accepted",
    code: "rate_limited",
  });
  await h.service.deliver({ deliveryId: retry.delivery.id });
  expect(await row(retry.delivery.id)).toMatchObject({
    status: "pending",
    attemptNo: 1,
    dueAt: new Date(h.clock.now().getTime() + 30_000),
  });
  expect(
    await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: retry.identity.id } }),
  ).toMatchObject({ estRemaining: 1 });
  h.clock.advance(30_000);
  await h.service.deliver({ deliveryId: retry.delivery.id });
  expect(await row(retry.delivery.id)).toMatchObject({ status: "sent", attemptNo: 2 });
});
it("冷lease已开始为unknown，未开始可重入，扫描不跨attempt写", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  await h.prisma.notificationDelivery.update({
    where: { id: w.delivery.id },
    data: { status: "sending", attemptNo: 1, leaseUntil: new Date(h.clock.now().getTime() - 1) },
  });
  await h.service.scan(async () => {});
  expect(await row(w.delivery.id)).toMatchObject({
    status: "pending",
    attemptNo: 1,
    callStartedAt: null,
  });
  await h.prisma.notificationDelivery.update({
    where: { id: w.delivery.id },
    data: {
      status: "sending",
      attemptNo: 2,
      callStartedAt: h.clock.now(),
      leaseUntil: new Date(h.clock.now().getTime() - 1),
    },
  });
  await h.service.scan(async () => {});
  expect(await row(w.delivery.id)).toMatchObject({
    status: "failed",
    reason: "unknown_outcome",
    attemptNo: 2,
  });
});
it("真实注销清除消息/额度/目标并取消未开始投递，不留下sending lease", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  await h.prisma.notificationDelivery.update({
    where: { id: w.delivery.id },
    data: {
      status: "sending",
      attemptNo: 1,
      leaseUntil: new Date(h.clock.now().getTime() + 60_000),
    },
  });
  await h.prisma.merchantUser.update({
    where: { id: own.user.id },
    data: {
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      deletedAt: h.clock.now(),
    },
  });
  await h.tx.run((t) =>
    h.service.onMerchantUserDeleted(t, {
      id: w.notification.id,
      type: "merchant_user.deleted",
      payload: { v: 1, merchantUserId: own.user.id },
    }),
  );
  expect(await h.prisma.merchantMessage.count({ where: { merchantUserId: own.user.id } })).toBe(0);
  expect(await h.prisma.wxSubscribeQuota.count({ where: { merchantUserId: own.user.id } })).toBe(0);
  expect(await row(w.delivery.id)).toMatchObject({
    status: "cancelled",
    reason: "guard_invalid",
    leaseUntil: null,
    targetRef: null,
  });
});
it("第二连接真实关闭订阅回执与失败T3竞争，归还不能复活已拒绝额度", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  h.providers.wechat.failNotificationNext("sendSubscribeMessage", {
    acceptance: "not_accepted",
    code: "provider_rejected",
  });
  h.providers.wechat.delayNext("sendSubscribeMessage", 1000);
  const pending = h.service.deliver({ deliveryId: w.delivery.id });
  await vi.waitFor(() => expect(h.providers.wechat.pendingCalls()).toBe(1));
  const callback = createWechatReceiptHandler({ clock: h.clock, logger: h.deps.logger });
  await createTxRunner({ prisma: other, appEnv: "test" }).run((t) =>
    callback(
      t,
      {
        event: "subscribe_msg_change_event",
        wechatIdentityId: w.identity.id,
        items: [{ templateId: "fictional-order-result" }],
        receivedAt: h.clock.now(),
      },
      createIdentityContext({ actor: { type: "system", job: "webhook.reprocess" } }),
    ),
  );
  h.clock.advance(1000);
  h.providers.wechat.tick();
  await pending;
  expect(
    await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: w.identity.id } }),
  ).toMatchObject({ state: "rejected", estRemaining: 0 });
});
it("原primary成功应答迟到可修正unknown并取消尚未开始SMS，仍不返WX额度", async () => {
  await h.prisma.notifyScene.update({
    where: { sceneKey: "m.order_submitted" },
    data: { smsPolicy: "fallback", smsTemplateKey: "generic_todo" },
  });
  const own = await h.merchant(),
    w = await h.wx(own);
  h.providers.wechat.delayNext("sendSubscribeMessage", 1000);
  const pending = h.service.deliver({ deliveryId: w.delivery.id });
  await vi.waitFor(() => expect(h.providers.wechat.pendingCalls()).toBe(1));
  h.clock.advance(31_000);
  await h.service.scan(async () => {});
  expect(await row(w.delivery.id)).toMatchObject({ status: "failed", reason: "unknown_outcome" });
  const fallback = await h.prisma.notificationDelivery.findFirstOrThrow({
    where: { notificationId: w.notification.id, channel: "sms", origin: "fallback" },
  });
  expect(fallback.status).toBe("pending");
  h.providers.wechat.tick();
  await pending;
  expect(await row(w.delivery.id)).toMatchObject({ status: "sent", reason: null, attemptNo: 1 });
  expect(await row(fallback.id)).toMatchObject({
    status: "cancelled",
    reason: "primary_late_success",
    leaseUntil: null,
    callStartedAt: null,
  });
  expect(
    await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: w.identity.id } }),
  ).toMatchObject({ estRemaining: 0 });
});
it("同recipient同scene并发collapse串行，第二通知站内保留而外呼仅一次", async () => {
  await h.prisma.notifyScene.update({
    where: { sceneKey: "m.order_submitted" },
    data: { collapseWindowSec: 600 },
  });
  const own = await h.merchant(),
    first = await h.wx(own);
  const secondOrder = await h.make.dramaOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    placedByUserId: own.user.id,
    subscriptionTermId: own.term.id,
  });
  const second = await h.wx({ ...own, order: secondOrder });
  await Promise.all([
    h.service.deliver({ deliveryId: first.delivery.id }),
    service2.deliver({ deliveryId: second.delivery.id }),
  ]);
  const rows = await Promise.all([row(first.delivery.id), row(second.delivery.id)]);
  expect(rows.map((v) => v.status).sort()).toEqual(["sent", "skipped"]);
  expect(rows.find((v) => v.status === "skipped")?.reason).toBe("collapsed");
  expect(
    await h.prisma.merchantMessage.count({
      where: { notificationId: { in: [first.notification.id, second.notification.id] } },
    }),
  ).toBe(2);
  expect(
    await h.prisma.wxSubscribeQuota.aggregate({
      where: { merchantUserId: own.user.id },
      _sum: { estRemaining: true },
    }),
  ).toMatchObject({ _sum: { estRemaining: 1 } });
});
it("真实10秒发送边界与close清理，已可能受理的取消只能unknown且不会再发", async () => {
  const own = await h.merchant(),
    w = await h.wx(own),
    local = createNotifyDispatcher(h.deps);
  h.providers.wechat.delayNext("sendSubscribeMessage", 60_000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const originalTimer = globalThis.setTimeout;
  let deadline = 0;
  const scheduled = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 10_000) deadline = Date.now() + 10_000;
      return originalTimer(...args);
    });
  try {
    const pending = local.deliver({ deliveryId: w.delivery.id });
    await vi.waitFor(() => expect(h.providers.wechat.pendingCalls()).toBe(1));
    expect(deadline).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
    expect(h.providers.wechat.pendingCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(await row(w.delivery.id)).toMatchObject({
      status: "failed",
      reason: "unknown_outcome",
      leaseUntil: null,
    });
    await local.close();
    expect(h.providers.wechat.pendingCalls()).toBe(0);
    await service2.deliver({ deliveryId: w.delivery.id });
    expect(
      h.providers.wechat
        .callsOf("sendSubscribeMessage")
        .filter((v) => (v.input as { openid: string }).openid === w.identity.openid),
    ).toHaveLength(1);
  } finally {
    scheduled.mockRestore();
    vi.useRealTimers();
    await local.close();
  }
});
it("活跃业务TX内不能启动三TX发送，拒绝时尚未认领或消费额度", async () => {
  const own = await h.merchant(),
    w = await h.wx(own);
  await expect(h.tx.run(() => h.service.deliver({ deliveryId: w.delivery.id }))).rejects.toThrow();
  expect(await row(w.delivery.id)).toMatchObject({
    status: "pending",
    attemptNo: 0,
    callStartedAt: null,
  });
  expect(
    await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: w.identity.id } }),
  ).toMatchObject({ estRemaining: 1 });
  expect(
    h.providers.wechat
      .callsOf("sendSubscribeMessage")
      .filter((value) => (value.input as { openid: string }).openid === w.identity.openid),
  ).toHaveLength(0);
});
it("非人工订阅和补发均不可送时只转真实当前经理；迟后注销使员工外呼取消", async () => {
  const own = await h.merchant(),
    w = await h.wx(own),
    manager = await h.make.staff();
  await h.prisma.store.update({
    where: { id: own.store.id },
    data: { deliveryManagerId: manager.id },
  });
  await h.prisma.notifyScene.update({
    where: { sceneKey: "m.order_submitted" },
    data: { smsPolicy: "fallback", smsTemplateKey: "generic_todo", managerEscalationEnabled: true },
  });
  h.providers.wechat.failNext("sendSubscribeMessage");
  await h.service.deliver({ deliveryId: w.delivery.id });
  const sms = await h.prisma.notificationDelivery.findFirstOrThrow({
    where: { notificationId: w.notification.id, channel: "sms" },
  });
  await h.service.deliver({ deliveryId: sms.id });
  const escalation = await h.prisma.notification.findFirstOrThrow({
    where: { bizId: w.notification.id, notifySceneKey: "s.merchant_unreached" },
  });
  expect(escalation).toMatchObject({
    staffId: manager.id,
    entityId: own.entity.id,
    storeId: own.store.id,
  });
  expect(escalation.vars).toMatchObject({ guardBizType: "drama_order", guardBizId: own.order.id });
  const pending = await h.prisma.notificationDelivery.findFirstOrThrow({
    where: { notificationId: escalation.id, channel: "wecom" },
  });
  await h.prisma.merchantUser.update({
    where: { id: own.user.id },
    data: {
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      deletedAt: h.clock.now(),
    },
  });
  await h.service.deliver({ deliveryId: pending.id });
  expect(await row(pending.id)).toMatchObject({
    status: "cancelled",
    reason: "guard_invalid",
    callStartedAt: null,
  });
});

it("企业微信普通员工immediate仍遵守真实节假日，站内立即而外部顺延到下一工作日", async () => {
  await seedWorkCalendar(h.prisma, {
    from: "2026-10-09",
    to: "2026-10-12",
    holidays: ["2026-10-09"],
  });
  h.clock.set(new Date("2026-10-09T04:00:00.000Z"));
  const { staff, delivery } = await staffDelivery();
  expect(delivery.dueAt).toEqual(new Date("2026-10-12T01:00:00.000Z"));
  expect(await h.prisma.staffMessage.count({ where: { staffId: staff.id } })).toBe(1);
  await h.service.deliver({ deliveryId: delivery.id });
  expect(await row(delivery.id)).toMatchObject({
    status: "pending",
    attemptNo: 0,
    callStartedAt: null,
  });
  expect(
    h.providers.wecom.messages.filter((value) => value.toUser === staff.wecomUserid),
  ).toHaveLength(0);
});

it("企业微信读取真实调休周六工作日，在当前工作时段可发送而非周末一律跳过", async () => {
  await seedWorkCalendar(h.prisma, {
    from: "2026-10-10",
    to: "2026-10-12",
    adjustedWorkdays: ["2026-10-10"],
  });
  h.clock.set(new Date("2026-10-10T02:00:00.000Z"));
  const { staff, delivery } = await staffDelivery();
  expect(delivery.dueAt).toEqual(h.clock.now());
  await h.service.deliver({ deliveryId: delivery.id });
  expect(await row(delivery.id)).toMatchObject({ status: "sent", attemptNo: 1 });
  expect(
    h.providers.wecom.messages.filter((value) => value.toUser === staff.wecomUserid),
  ).toHaveLength(1);
});

it("企业微信发送前按当前工作时段再守卫，修订顺延不消耗attempt且清租约，到点可发", async () => {
  await seedWorkCalendar(h.prisma, { from: "2026-10-14", to: "2026-10-15" });
  h.clock.set(new Date("2026-10-14T02:00:00.000Z"));
  const { staff, delivery } = await staffDelivery();
  expect(delivery.dueAt).toEqual(h.clock.now());
  await h.prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "work.start",
      value: "11:00",
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: staff.id,
      reason: "虚构工作时段修订",
    },
  });
  await h.service.deliver({ deliveryId: delivery.id });
  expect(await row(delivery.id)).toMatchObject({
    status: "pending",
    attemptNo: 0,
    dueAt: new Date("2026-10-14T03:00:00.000Z"),
    leaseUntil: null,
    callStartedAt: null,
  });
  expect(
    h.providers.wecom.messages.filter((value) => value.toUser === staff.wecomUserid),
  ).toHaveLength(0);
  h.clock.set(new Date("2026-10-14T03:00:00.000Z"));
  await h.service.deliver({ deliveryId: delivery.id });
  expect(await row(delivery.id)).toMatchObject({ status: "sent", attemptNo: 1 });
  expect(
    h.providers.wecom.messages.filter((value) => value.toUser === staff.wecomUserid),
  ).toHaveLength(1);
});

it("关闭等待三TX投递的在途准备，尚未外呼就停止并真实归还额度、清租约", async () => {
  const own = await h.merchant(),
    wx = await h.wx(own);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = createNotifyDispatcher({
    ...h.deps,
    wxEnabled: async () => {
      enter();
      await gate;
      return true;
    },
  });
  const sending = local.deliver({ deliveryId: wx.delivery.id });
  let shut = false;
  let shutdown: Promise<void> | undefined;
  try {
    await entered;
    shutdown = local.close().then(() => {
      shut = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shut).toBe(false);
    release();
    await Promise.all([sending, shutdown]);
    expect(await row(wx.delivery.id)).toMatchObject({
      status: "pending",
      errorCode: "aborted",
      leaseUntil: null,
    });
    expect(
      await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: wx.identity.id } }),
    ).toMatchObject({ estRemaining: 1 });
    expect(
      h.providers.wechat
        .callsOf("sendSubscribeMessage")
        .filter((value) => (value.input as { openid: string }).openid === wx.identity.openid),
    ).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled([sending, shutdown]);
    await local.close();
  }
});
