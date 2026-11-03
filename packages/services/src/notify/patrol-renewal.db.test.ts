import { afterAll, beforeAll, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { addDays } from "@liyoxi/shared/time";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import {
  createFactories,
  createLedgerHarness,
  createPatrolTestRuntime,
  openTerm,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";

const db = useSeededDatabase("services");
const redis = useTestRedis();
let stack: ReturnType<typeof createPatrolTestRuntime>;
const tables = [
  "subscription_term",
  "manual_reminder_log",
  "outbox_event",
  "idempotency_record",
  "notification",
  "notification_delivery",
  "merchant_message",
];

beforeAll(async () => {
  stack = createPatrolTestRuntime({
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
});
afterAll(async () => {
  await stack?.runtime.close();
});

async function fixture() {
  const prisma = await db.prisma();
  stack.clock.set(new Date("2026-01-05T04:00:00.000Z"));
  const make = createFactories({ db: prisma, clock: stack.clock });
  const owner = await make.merchant({ verified: true });
  // 复用既有合法订阅边界；本例验收真实催办生产者与消费者，不冒称付款链验收。
  const { term } = await openTerm(createLedgerHarness(prisma, { clock: stack.clock }), {
    entityId: owner.entity.id,
  });
  const employee = await make.staff({ staffRoleKey: "super_admin" });
  const identity = createIdentityContext({
    actor: { type: "staff", id: employee.id, client: "admin" },
  });
  const staff = await sampleStaffContext(prisma, employee.id);
  const request = (key = uuidv7()) =>
    createIdempotencyContext({
      mode: "required",
      scope: "admin.subscriptionTerm.remind",
      actor: identity.actor,
      key,
      request: { method: "POST", pathParams: { subscriptionTermId: term.id }, body: {} },
    });
  const produce = (idem = request()) =>
    stack.runtime.billing.subscriptions.remind({ identity, staff }, term.id, { idem });
  async function source() {
    const first = await produce();
    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "manual_reminder.sent", aggregateId: first.manualReminderLogId },
    });
    return {
      id: outbox.id,
      type: "manual_reminder.sent",
      payload: EVENT_PAYLOAD_SCHEMAS["manual_reminder.sent"].parse(outbox.payload),
    };
  }
  return { prisma, owner, term, request, produce, source };
}

it("真实续费催办日志与出站事件只派发R1的M消息，重放零新增且无关或缺失日志零写", async () => {
  const h = await fixture();
  const key = uuidv7();
  const result = await h.produce(h.request(key));
  const produced = await snapshotTables(h.prisma, tables);
  const replay = h.request(key);
  expect(await h.produce(replay)).toEqual(result);
  expect(replay.replayed).toBe(true);
  expect(await snapshotTables(h.prisma, tables)).toEqual(produced);
  await expect(h.produce()).rejects.toMatchObject({ error: "REMINDED_TODAY" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(produced);
  const outbox = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "manual_reminder.sent", aggregateId: result.manualReminderLogId },
  });
  const event = {
    id: outbox.id,
    type: "manual_reminder.sent",
    payload: EVENT_PAYLOAD_SCHEMAS["manual_reminder.sent"].parse(outbox.payload),
  };
  expect(await stack.runtime.tx.run((tx) => stack.runtime.notify.onEvent(tx, event))).toBe(1);
  const notifications = await h.prisma.notification.findMany({ where: { bizId: h.term.id } });
  expect(notifications).toEqual([
    expect.objectContaining({
      notifySceneKey: "m.plan_expiring",
      bizType: "subscription_term",
      node: "M",
      merchantUserId: h.owner.user.id,
      sourceOutboxEventId: outbox.id,
    }),
  ]);
  const notificationId = notifications[0]!.id;
  expect(await h.prisma.merchantMessage.count({ where: { notificationId } })).toBe(1);
  expect(
    await h.prisma.notificationDelivery.findMany({
      where: { notificationId, channel: "inbox" },
    }),
  ).toEqual([expect.objectContaining({ status: "sent" })]);
  const delivered = await snapshotTables(h.prisma, tables);
  expect(await stack.runtime.tx.run((tx) => stack.runtime.notify.onEvent(tx, event))).toBe(0);
  for (const payload of [
    { ...event.payload, manualReminderLogId: uuidv7() },
    { ...event.payload, subjectId: uuidv7() },
    { ...event.payload, bizDate: addDays(event.payload.bizDate, 1) },
  ]) {
    expect(
      await stack.runtime.tx.run((tx) => stack.runtime.notify.onEvent(tx, { ...event, payload })),
    ).toBe(0);
  }
  expect(await snapshotTables(h.prisma, tables)).toEqual(delivered);
});

it("真实R1在超过到期30日后拒绝旧催办事件，原日志存在也不能绕过消费者或生产者守卫", async () => {
  const h = await fixture();
  const event = await h.source();
  stack.clock.set(new Date(h.term.endsAt.getTime() + 31 * 86_400_000));
  const before = await snapshotTables(h.prisma, tables);
  expect(await stack.runtime.tx.run((tx) => stack.runtime.notify.onEvent(tx, event))).toBe(0);
  await expect(h.produce()).rejects.toMatchObject({ error: "REMIND_NOT_APPLICABLE" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  expect(await h.prisma.notification.count({ where: { bizId: h.term.id } })).toBe(0);
});
