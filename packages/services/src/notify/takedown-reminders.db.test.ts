import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, atMinuteOfDay } from "@liyoxi/shared/time";
import type { OutboxEvent } from "@liyoxi/db";
import { createTakedownFixture, useSeededDatabase } from "../testing/index.js";
import { currentReminderFact } from "./dispatch.js";
const db = useSeededDatabase("services", { max: 2 });
beforeAll(async () => {
  await db.prisma();
});
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const h = createTakedownFixture(await db.prisma()),
    n = h.createNotifyFixture();
  closes.push(
    () => h.close(),
    () => n.service.close(),
  );
  const consume = (event: OutboxEvent) =>
    n.tx.run((tx) =>
      n.service.onEvent(tx, {
        id: event.id,
        type: event.eventType,
        payload: event.payload as Record<string, unknown>,
      }),
    );
  const latest = (type: string, id: string) =>
    h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: type, aggregateId: id },
      orderBy: { seq: "desc" },
    });
  return { h, n, consume, latest };
}
async function preparedFixture(daysBeforeEnd: number) {
  const scope = await fixture();
  const f = await scope.h.ready({ twoAccounts: true, daysBeforeEnd });
  return { ...scope, f };
}
describe("R3节点与事件来源", () => {
  let prepared!: Awaited<ReturnType<typeof preparedFixture>>;
  beforeEach(async () => {
    prepared = await preparedFixture(30);
  });
  it("真实创建与R3四节点按门店×止日×收件人合并，重复扫描零新增且发前重验", async () => {
    const { h, n, consume, latest, f } = prepared;
    const end = f.item.usageEndDate.toISOString().slice(0, 10);
    n.clock.set(h.clock.now());
    const event = await latest("takedown.created", f.takedowns[0]!.id);
    expect(await consume(event)).toBe(1);
    expect(await consume(await latest("takedown.created", f.takedowns[1]!.id))).toBe(0);
    for (const days of [30, 7, 1, 0]) {
      n.clock.set(atMinuteOfDay(addDays(end, -days), 540));
      h.clock.set(n.clock.now());
      await n.service.remindScan({ scheduledFor: n.clock.now() });
    }
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    const rows = await h.prisma.notification.findMany({
      where: { notifySceneKey: "m.offline_remind", bizType: "store", storeId: f.o.store.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.node).sort()).toEqual(["T-0", "T-1", "T-30", "T-7"]);
    for (const row of rows)
      expect(row.dedupeKey).toBe(`offline:${f.o.store.id}:${end}:${row.node}:${f.o.user.id}`);
    expect(rows[0]!.bizType).toBe("store");
    expect(rows[0]).toMatchObject({ sourceOutboxEventId: event.id, sourceRule: null });
    expect(
      rows.slice(1).every((row) => row.sourceRule === "R3" && row.sourceOutboxEventId === null),
    ).toBe(true);
    const before = await n.tx.run((tx) => currentReminderFact(tx, n.deps, rows[0]!));
    expect(before?.items?.[0]?.pendingAccounts).toHaveLength(2);
    await h.takedown.confirm(f.o.viewer, f.takedowns[0]!.id, { method: "not_published" });
    const reduced = await n.tx.run((tx) => currentReminderFact(tx, n.deps, rows[0]!));
    expect(reduced?.items?.[0]?.pendingAccounts).toHaveLength(1);
    await h.takedown.confirm(f.o.viewer, f.takedowns[1]!.id, { method: "not_published" });
    expect(await n.tx.run((tx) => currentReminderFact(tx, n.deps, rows[0]!))).toBeNull();
    const pendingDelivery = await h.prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: rows[0]!.id, channel: "wx_subscribe" },
    });
    await n.service.deliver({ deliveryId: pendingDelivery.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: pendingDelivery.id } }),
    ).toMatchObject({ status: "cancelled", reason: "guard_invalid", callStartedAt: null });
    expect(n.providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
    expect(await consume(event)).toBe(0);
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    expect(
      await h.prisma.notification.count({
        where: { notifySceneKey: "m.offline_remind", bizType: "store", storeId: f.o.store.id },
      }),
    ).toBe(4);
  });
  it("R3先扫描时晚到created仍共享T-30键，保留规则来源且不重复", async () => {
    const { h, n, consume, latest, f } = prepared;
    const end = f.item.usageEndDate.toISOString().slice(0, 10);
    n.clock.set(atMinuteOfDay(addDays(end, -30), 540));
    h.clock.set(n.clock.now());
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    expect(await consume(await latest("takedown.created", f.takedowns[0]!.id))).toBe(0);
    expect(
      await h.prisma.notification.findMany({
        where: { storeId: f.o.store.id, notifySceneKey: "m.offline_remind" },
      }),
    ).toEqual([
      expect.objectContaining({
        sourceRule: "R3",
        sourceOutboxEventId: null,
        dedupeKey: `offline:${f.o.store.id}:${end}:T-30:${f.o.user.id}`,
      }),
    ]);
  });
});
describe("下架事实的事件消费", () => {
  let prepared!: Awaited<ReturnType<typeof preparedFixture>>;
  beforeEach(async () => {
    prepared = await preparedFixture(10);
  });
  it("确认/仍在线/逾期/违约/核查走真实事件消费，旧代不发送，逾期不创建系统跟进", async () => {
    const { h, n, consume, latest, f } = prepared;
    const id = f.takedowns[0]!.id;
    const publisher = await h.make.staff({ staffRoleKey: "publisher" }),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" });
    await h.prisma.deliveryTicket.update({
      where: { id: f.id },
      data: { publisherId: publisher.id },
    });
    await h.prisma.store.update({
      where: { id: f.o.store.id },
      data: { deliveryManagerId: manager.id },
    });
    n.clock.set(h.clock.now());
    await h.takedown.confirm(f.o.viewer, id, { method: "not_published" });
    const confirmed = await latest("takedown.merchant_confirmed", id);
    expect(await consume(confirmed)).toBe(1);
    expect(
      await h.prisma.notification.findFirst({
        where: { bizId: id, notifySceneKey: "s.publish_progress" },
      }),
    ).toMatchObject({ staffId: publisher.id });
    expect(
      await h.prisma.staffMessage.findFirst({
        where: { staffId: publisher.id, notification: { bizId: id } },
      }),
    ).toMatchObject({ link: { route: "publish.offline", params: {} } });
    await h.takedown.markOnline(f.qc.ctx, f.qc.staff, id, { note: "真实人工抽查仍在线" });
    expect(await consume(confirmed)).toBe(0);
    expect(await consume(await latest("takedown.found_online", id))).toBeGreaterThanOrEqual(2);
    h.clock.set(atMinuteOfDay(addDays(f.takedowns[0]!.dueDate.toISOString().slice(0, 10), 1), 540));
    n.clock.set(h.clock.now());
    await h.takedown.escalate(f.qc.ctx, f.qc.staff, id, {});
    expect(await consume(await latest("takedown.escalated", id))).toBeGreaterThanOrEqual(1);
    await h.takedown.sendBreachNotice(f.qc.ctx, f.qc.staff, id);
    const manual = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "manual_reminder.sent", payload: { path: ["subjectId"], equals: id } },
      orderBy: { seq: "desc" },
    });
    expect(await consume(manual)).toBe(1);
    expect(await consume(manual)).toBe(0);
    const breach = await h.prisma.notification.findFirstOrThrow({
      where: { sourceOutboxEventId: manual.id },
    });
    expect(breach).toMatchObject({ node: "M", notifySceneKey: "m.offline_remind", bizId: id });
    expect(breach.vars).toMatchObject({ summary: expect.stringContaining("24小时") });
    await h.takedown.check(f.qc.ctx, f.qc.staff, id, await h.checkBody(f, id));
    expect(await consume(await latest("takedown.checked", id))).toBe(1);
    expect(await consume(manual)).toBe(0);
    expect(
      await h.prisma.followUp.count({
        where: { subjectType: "takedown_task", subjectId: id, actorType: "system" },
      }),
    ).toBe(0);
  });
  it("未到逾期节点的依据重开只通知商家，同一时钟留下的旧升级时间不冒充新升级", async () => {
    const { h, n, consume, latest, f } = prepared;
    const row = f.takedowns[0]!;
    n.clock.set(h.clock.now());
    await h.takedown.confirm(f.o.viewer, row.id, { method: "not_published" });
    await h.takedown.markOnline(f.qc.ctx, f.qc.staff, row.id, {});
    await h.takedown.confirm(f.o.viewer, row.id, { method: "not_published" });
    await h.launch(f, row.launchTaskId);
    const event = await latest("takedown.basis_reopened", row.id);
    expect(await consume(event)).toBe(1);
    expect(
      await h.prisma.notification.findMany({ where: { sourceOutboxEventId: event.id } }),
    ).toEqual([
      expect.objectContaining({
        notifySceneKey: "m.order_progress",
        merchantUserId: f.o.user.id,
        staffId: null,
      }),
    ]);
  });
});
