import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxEvent } from "@liyoxi/db";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { uuidv7 } from "../kernel/index.js";
import {
  createPublishWorkbenchFixture,
  notificationFixture,
  useSeededDatabase,
} from "../testing/index.js";
import { specFor } from "./registry.js";

const db = useSeededDatabase("services", { max: 2 });
let h: ReturnType<typeof createPublishWorkbenchFixture>;
let n: ReturnType<typeof notificationFixture>;
let f: Awaited<ReturnType<typeof h.release>>;
let beforePush: OutboxEvent;
let publisher: Awaited<ReturnType<typeof h.make.staff>>;
let otherPublisher: Awaited<ReturnType<typeof h.make.staff>>;
const lists = () => h.publishLists;
const revoke = () => h.launchRevoke;
const consume = (event: OutboxEvent) =>
  n.tx.run((tx) =>
    n.service.onEvent(tx, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
async function latest(type: string, id: string) {
  return h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: type, aggregateId: id },
    orderBy: { seq: "desc" },
  });
}
async function save(ticketId: string, actor: Awaited<ReturnType<typeof h.staff>>, title: string) {
  const current = await lists().get(actor.staff, ticketId);
  return lists().replace(actor.ctx, actor.staff, ticketId, {
    lockVersion: current.lockVersion,
    collectionName: current.collectionName,
    coverFileId: current.cover?.fileId ?? null,
    titleTemplate: current.titleTemplate,
    topics: current.topics,
    intro: current.intro,
    episodes: [{ episodeNo: 1, title, highlight: null, topics: null, intro: null }],
  });
}
beforeAll(async () => {
  h = createPublishWorkbenchFixture(await db.prisma());
  n = notificationFixture(h.prisma);
  h.clock.set(new Date("2026-01-05T01:00:00Z"));
  n.clock.set(h.clock.now());
  f = await h.release(false, 1, async (prepared) => {
    const saved = await save(prepared.id, prepared.qc, "推包前清单");
    beforePush = await latest("publish_list.updated", saved.publishListId);
    expect(
      EVENT_PAYLOAD_SCHEMAS["publish_list.updated"].parse(beforePush.payload).isAfterPush,
    ).toBe(false);
    expect(await consume(beforePush)).toBe(0);
  });
  publisher = await h.make.staff({
    staffRoleKey: "publisher",
    wecomBindStatus: "bound",
    wecomUserid: `fictional-${uuidv7()}`,
    wecomBoundAt: h.clock.now(),
  });
  otherPublisher = await h.make.staff({
    staffRoleKey: "publisher",
    wecomBindStatus: "bound",
    wecomUserid: `fictional-${uuidv7()}`,
    wecomBoundAt: h.clock.now(),
  });
  // Assignment and member rows are fixture inputs; all list/release/launch outcomes use writers.
  await h.prisma.deliveryTicket.update({
    where: { id: f.id },
    data: { publisherId: publisher.id },
  });
  const clerk = await h.make.merchantUser();
  const member = await h.make.entityMember({ entityId: f.o.entity.id, merchantUserId: clerk.id });
  await h.make.storeMember({
    entityMemberId: member.id,
    storeId: f.o.store.id,
    addedByMemberId: f.o.member.id,
  });
  await h.prisma.notifyScene.update({
    where: { sceneKey: "m.order_progress" },
    data: {
      sceneEnabled: true,
      extEnabled: true,
      wxTemplateSlotKey: "order_result",
      smsPolicy: "never",
      sendWindow: "immediate",
    },
  });
  await h.prisma.notifyScene.update({
    where: { sceneKey: "s.publish_progress" },
    data: { sceneEnabled: true, extEnabled: true, sendWindow: "immediate" },
  });
}, 120_000);
afterAll(async () => {
  await n?.service.close();
  await h?.close();
});

describe("W6-02 两个冻结事件的真实通知消费", () => {
  it("推前不发；推后仅老板，重复/延迟旧版本不派发，旧待发送在新版本后取消", async () => {
    expect(await consume(beforePush)).toBe(0);
    const first = await save(f.id, f.qc, "第一版推后清单");
    const event = await latest("publish_list.updated", first.publishListId);
    expect(EVENT_PAYLOAD_SCHEMAS["publish_list.updated"].parse(event.payload)).toEqual({
      v: 1,
      publishListId: first.publishListId,
      deliveryTicketId: f.id,
      isAfterPush: true,
    });
    expect(await consume(event)).toBe(1);
    expect(await consume(event)).toBe(0);
    const notifications = await h.prisma.notification.findMany({
      where: { sourceOutboxEventId: event.id },
      include: { merchantMessage: true, notificationDeliveries: true },
    });
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification).toMatchObject({
      notifySceneKey: "m.order_progress",
      bizType: "publish_list",
      merchantUserId: f.o.user.id,
    });
    expect(notification.merchantMessage).toMatchObject({
      isOwnerOnly: true,
      category: "delivery",
      link: { route: "order.detail", params: { orderId: f.o.order.id, storeId: f.o.store.id } },
    });
    const queued = notification.notificationDeliveries.find((d) => d.channel === "wx_subscribe")!;
    expect(queued).toMatchObject({ status: "pending" });
    await save(f.id, f.qc, "第二版推后清单");
    const next = await latest("publish_list.updated", first.publishListId);
    expect(await consume(event)).toBe(0);
    expect(await consume(next)).toBe(1);
    await n.service.deliver({ deliveryId: queued.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: queued.id } }),
    ).toMatchObject({ status: "cancelled", reason: "guard_invalid", callStartedAt: null });
    expect(n.providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
    expect(specFor("m.order_progress", "publish_list")?.reader).toBe("publishListForNotify");
    expect(specFor("m.order_progress", "drama_order")?.reader).toBe("orderForNotify");
    expect(specFor("m.order_progress", "order_item")?.reader).toBe(
      "launchRescheduledItemForNotify",
    );
    expect(specFor("m.order_progress", "delivery_release")?.reader).toBe(
      "reissuedReleaseForNotify",
    );
  });

  it("真实核验撤销通知老板及当前发布专员；重复事件不重复，改派取消旧专员发送", async () => {
    const task = await h.prisma.launchTask.findFirstOrThrow({ where: { deliveryTicketId: f.id } });
    await h.deps.publish.submitLaunch(f.o.viewer, task.id, {
      linkKind: "collection",
      collectionUrl: "https://example.invalid/notify-launch",
      reportedEpisodeCount: 1,
      actualLaunchDate: "2026-01-05",
    });
    const submission = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: task.id },
      include: { approvalRequest: true },
    });
    await h.deps.publish.approveLaunch(f.qc.ctx, f.qc.staff, submission.id, {
      lockVersion: submission.approvalRequest.lockVersion,
      confirm: { roundNo: 1, reportedEpisodeCount: 1 },
      verifiedEpisodeCount: 1,
      ...(await h.checks("launch.verify")),
    });
    await revoke().revoke(f.qc.ctx, f.qc.staff, submission.id, {
      reason: "通知闭环真实撤销",
      confirm: { roundNo: 1, verifiedEpisodeCount: 1 },
    });
    const event = await latest("launch.verify_revoked", task.id);
    expect(EVENT_PAYLOAD_SCHEMAS["launch.verify_revoked"].parse(event.payload)).toEqual({
      v: 1,
      launchTaskId: task.id,
      orderItemId: f.item.id,
      isLive: false,
      fromState: "passed",
      toState: "verifying",
      transition: "launch.verify_revoke",
    });
    expect(await consume(event)).toBe(2);
    expect(await consume(event)).toBe(0);
    const rows = await h.prisma.notification.findMany({
      where: { sourceOutboxEventId: event.id },
      include: { merchantMessage: true, staffMessage: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.merchantUserId)).toMatchObject({
      notifySceneKey: "m.order_progress",
      merchantUserId: f.o.user.id,
      merchantMessage: {
        isOwnerOnly: true,
        category: "launch",
        link: { route: "publish.task", params: { launchTaskId: task.id, storeId: f.o.store.id } },
      },
    });
    expect(rows.find((r) => r.staffId)).toMatchObject({
      notifySceneKey: "s.publish_progress",
      staffId: publisher.id,
      staffMessage: { link: { route: "publish.verify", params: {} } },
    });
    const staffNotice = rows.find((r) => r.staffId)!;
    const delivery = await h.prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: staffNotice.id, channel: "wecom" },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: f.id },
      data: { publisherId: otherPublisher.id },
    });
    await n.service.deliver({ deliveryId: delivery.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: delivery.id } }),
    ).toMatchObject({ status: "cancelled", reason: "guard_invalid", callStartedAt: null });
    expect(n.providers.wecom.callsOf("sendAppMessage")).toHaveLength(0);
    const orderEvent = await latest("order.item.live_revoked", f.item.id);
    expect(await consume(orderEvent)).toBe(1);
    expect(await consume(orderEvent)).toBe(0);
    expect(
      await h.prisma.notification.findMany({ where: { sourceOutboxEventId: orderEvent.id } }),
    ).toMatchObject([
      { merchantUserId: f.o.user.id, bizType: "drama_order", notifySceneKey: "m.order_progress" },
    ]);
    expect(specFor("s.publish_progress", "launch_task")?.reader).toBe("launchRevokedForNotify");
    expect(specFor("s.publish_progress", "drama_order")).toBeUndefined();
  });

  it("新核验通过使旧待办失效；下一次撤销只消费新轮，读取当前发布专员", async () => {
    const task = await h.prisma.launchTask.findFirstOrThrow({ where: { deliveryTicketId: f.id } });
    const oldEvent = await latest("launch.verify_revoked", task.id);
    const reopened = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: task.id, result: "pending" },
      include: { approvalRequest: true },
    });
    const reviewer = await h.staff();
    await h.deps.publish.approveLaunch(reviewer.ctx, reviewer.staff, reopened.id, {
      lockVersion: reopened.approvalRequest.lockVersion,
      confirm: { roundNo: 2, reportedEpisodeCount: 1 },
      verifiedEpisodeCount: 1,
      ...(await h.checks("launch.verify")),
    });
    expect(await consume(oldEvent)).toBe(0);
    const queued = await h.prisma.notificationDelivery.findFirstOrThrow({
      where: { channel: "wx_subscribe", notification: { sourceOutboxEventId: oldEvent.id } },
    });
    await n.service.deliver({ deliveryId: queued.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: queued.id } }),
    ).toMatchObject({ status: "cancelled", reason: "guard_invalid", callStartedAt: null });
    await revoke().revoke(f.qc.ctx, f.qc.staff, reopened.id, {
      reason: "第二轮真实撤销",
      confirm: { roundNo: 2, verifiedEpisodeCount: 1 },
    });
    const next = await latest("launch.verify_revoked", task.id);
    expect(next.id).not.toBe(oldEvent.id);
    expect(await consume(oldEvent)).toBe(0);
    expect(await consume(next)).toBe(2);
    expect(await consume(next)).toBe(0);
    const rows = await h.prisma.notification.findMany({ where: { sourceOutboxEventId: next.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.staffId)).toMatchObject({
      staffId: otherPublisher.id,
      vars: { version: 3 },
    });
    expect(rows.some((r) => r.staffId === publisher.id)).toBe(false);
  });
});
