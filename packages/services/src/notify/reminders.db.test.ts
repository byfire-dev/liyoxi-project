import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
}, 120_000);
afterAll(async () => {
  await h?.service.close();
});
async function sample(pushedAt: Date) {
  const own = await h.merchant(),
    manager = await h.make.staff(),
    editor = await h.make.staff({ staffRoleKey: "editor" });
  const item = await h.make.orderItem({ dramaOrderId: own.order.id, phase: "producing" });
  const ticket = await h.make.deliveryTicket({
    orderItemId: item.id,
    step: "sample_confirm",
    currentSampleVersionNo: 1,
    deliveryManagerId: manager.id,
    editorId: editor.id,
    waitingOn: "merchant",
  });
  const file = await h.make.fileObject({
    category: "sample_video",
    ext: "mp4",
    scopeType: "store",
    entityId: own.entity.id,
    storeId: own.store.id,
    bucket: "secure",
    declaredMime: "video/mp4",
    mime: "video/mp4",
  });
  const id = uuidv7(),
    qcId = uuidv7();
  await h.prisma.qcRecord.create({
    data: {
      id: qcId,
      entityId: own.entity.id,
      storeId: own.store.id,
      deliveryTicketId: ticket.id,
      targetType: "sample",
      targetId: id,
      checklistCode: "qc.sample",
      checklistVersionNo: 1,
      results: [],
      verdict: "pass",
      inspectedByStaffId: manager.id,
      inspectedAt: pushedAt,
      createdAt: pushedAt,
    },
  });
  const row = await h.prisma.sample.create({
    data: {
      id,
      entityId: own.entity.id,
      storeId: own.store.id,
      deliveryTicketId: ticket.id,
      versionNo: 1,
      fileId: file.id,
      durationMs: 10_000,
      adSlots: [],
      adVersionsUsed: [],
      status: "pushed",
      qcRecordId: qcId,
      uploadedByStaffId: editor.id,
      uploadedAt: pushedAt,
      pushedByStaffId: manager.id,
      pushedAt,
      previewChannels: ["weapp"],
      createdAt: pushedAt,
      updatedAt: pushedAt,
    },
  });
  return { own, ticket, row };
}
it("R4按上海两自然日而非48小时，节点与接收人去重，未满自然日不催", async () => {
  h.clock.set(new Date("2026-10-07T16:00:00.000Z"));
  const eligible = await sample(new Date("2026-10-06T15:59:00.000Z"));
  const young = await sample(new Date("2026-10-06T16:00:00.000Z"));
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(
    await h.prisma.notification.count({
      where: { bizId: eligible.row.id, node: "R1", sourceRule: "R4" },
    }),
  ).toBe(1);
  expect(await h.prisma.notification.count({ where: { bizId: young.row.id, node: "R1" } })).toBe(0);
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: eligible.row.id, node: "R1" } })).toBe(
    1,
  );
  await h.tx.run((t) =>
    h.service.onEvent(t, {
      id: uuidv7(),
      type: "sample.pushed",
      payload: { v: 1, sampleId: eligible.row.id },
    }),
  );
  expect(await h.prisma.notification.count({ where: { bizId: eligible.row.id } })).toBe(2);
});
it("R4取消token零写，已换版本/已暂停当前事实不催，超过grace不补旧节点", async () => {
  const target = await sample(new Date("2026-10-06T12:00:00.000Z"));
  const controller = new AbortController();
  controller.abort();
  await h.service.remindScan({ scheduledFor: h.clock.now(), signal: controller.signal });
  expect(await h.prisma.notification.count({ where: { bizId: target.row.id } })).toBe(0);
  await h.prisma.deliveryTicket.update({
    where: { id: target.ticket.id },
    data: { pausedAt: h.clock.now(), pauseCount: 1 },
  });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: target.row.id } })).toBe(0);
  const replaced = await sample(new Date("2026-10-06T12:00:00.000Z"));
  await h.prisma.deliveryTicket.update({
    where: { id: replaced.ticket.id },
    data: { currentSampleVersionNo: 2 },
  });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: replaced.row.id } })).toBe(0);
  h.clock.set(new Date("2026-10-08T05:00:00.000Z"));
  const late = await sample(new Date("2026-10-06T12:00:00.000Z"));
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: late.row.id } })).toBe(0);
});
it("跟进到期日09:00才提醒当前owner，重复扫描一次；改派后只新owner可发送", async () => {
  h.clock.set(new Date("2026-10-08T00:59:59.000Z"));
  const own = await h.merchant(),
    manager = await h.make.staff(),
    other = await h.make.staff();
  const row = await h.prisma.followUp.create({
    data: {
      id: uuidv7(),
      subjectType: "store",
      subjectId: own.store.id,
      entityId: own.entity.id,
      storeId: own.store.id,
      content: "虚构跟进待办",
      nextFollowAt: new Date("2026-10-08T06:00:00.000Z"),
      ownerStaffId: manager.id,
      actorType: "system",
      channel: "system",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: row.id } })).toBe(0);
  h.clock.advance(1000);
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  const first = await h.prisma.notification.findFirstOrThrow({
    where: { bizId: row.id, staffId: manager.id },
  });
  expect(await h.prisma.notification.count({ where: { bizId: row.id } })).toBe(1);
  const pending = await h.prisma.notificationDelivery.findFirstOrThrow({
    where: { notificationId: first.id, channel: "wecom" },
  });
  await h.prisma.followUp.update({
    where: { id: row.id },
    data: { ownerStaffId: other.id, lockVersion: { increment: 1 } },
  });
  await h.service.deliver({ deliveryId: pending.id });
  expect(
    await h.prisma.notificationDelivery.findUnique({ where: { id: pending.id } }),
  ).toMatchObject({ status: "cancelled", reason: "guard_invalid" });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: row.id, staffId: other.id } })).toBe(
    1,
  );
  await h.prisma.followUp.update({
    where: { id: row.id },
    data: { doneAt: h.clock.now(), lockVersion: { increment: 1 } },
  });
  await h.service.remindScan({ scheduledFor: h.clock.now() });
  expect(await h.prisma.notification.count({ where: { bizId: row.id } })).toBe(2);
});
