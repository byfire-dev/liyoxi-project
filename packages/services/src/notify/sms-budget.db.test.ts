import { describe, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { createClock, useSeededDatabase } from "../testing/index.js";
import { lockSmsBudget, smsDayUsage } from "./sms-budget.js";

const db = useSeededDatabase("services");

async function setup() {
  await db.reset();
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const clock = createClock(new Date("2026-10-14T02:20:00.000Z"));
  const targetRef = "a".repeat(64);
  const now = clock.now();
  const add = (
    overrides: Partial<Parameters<typeof prisma.notificationDelivery.create>[0]["data"]>,
  ) =>
    prisma.notificationDelivery.create({
      data: {
        id: uuidv7(),
        isDirect: true,
        channel: "sms",
        origin: "direct",
        status: "sending",
        purpose: "keepalive",
        smsTemplateKey: "account_notice",
        targetRef,
        directKey: `sms_keepalive:${uuidv7()}`,
        dueAt: now,
        createdAt: now,
        updatedAt: now,
        leaseUntil: new Date(now.getTime() + 30_000),
        attemptNo: 1,
        maxAttempts: 1,
        ...overrides,
      },
    });
  const used = () =>
    tx.run(async (client) => {
      expect(await lockSmsBudget(client, ["account_notice"])).toBe(true);
      return smsDayUsage(client, { targetRef, now: clock.now() });
    });
  return { prisma, tx, clock, targetRef, now, add, used };
}

describe("短信同号自然日预算的真实调用与有效健康预约", () => {
  it("callStartedAt按北京时间左闭右开，终态不退款，创建日不替代开始日", async () => {
    const h = await setup();
    const dayStart = new Date("2026-10-13T16:00:00.000Z");
    const dayEnd = new Date("2026-10-14T16:00:00.000Z");
    await h.add({
      purpose: "account_notice",
      directKey: null,
      createdAt: new Date(dayStart.getTime() - 1000),
      callStartedAt: dayStart,
      status: "failed",
      reason: "unknown_outcome",
      finishedAt: h.now,
      leaseUntil: null,
    });
    await h.add({
      purpose: "account_notice",
      directKey: null,
      callStartedAt: new Date(dayEnd.getTime() - 1),
      status: "failed",
      reason: "provider_rejected",
      finishedAt: dayEnd,
      leaseUntil: null,
    });
    await h.add({ callStartedAt: new Date(dayStart.getTime() - 1) });
    await h.add({ callStartedAt: dayEnd });
    await h.add({ callStartedAt: h.now, targetRef: "b".repeat(64) });
    expect(await h.used()).toBe(2);
  }, 60_000);

  it("只有本日有效未开始keepalive预约占额；转为实际调用只计一次", async () => {
    const h = await setup();
    const reservation = await h.add({});
    await h.add({ leaseUntil: h.now });
    await h.add({
      createdAt: new Date("2026-10-13T15:59:59.999Z"),
    });
    await h.add({ purpose: "account_notice" });
    await h.add({ directKey: `other:${uuidv7()}` });
    await h.add({
      status: "cancelled",
      reason: "guard_invalid",
      finishedAt: h.now,
      leaseUntil: null,
    });
    expect(await h.used()).toBe(1);
    await h.tx.run(async (client) => {
      expect(await lockSmsBudget(client, ["account_notice"])).toBe(true);
      await client.notificationDelivery.update({
        where: { id: reservation.id },
        data: { callStartedAt: h.now },
      });
      expect(await smsDayUsage(client, { targetRef: h.targetRef, now: h.now })).toBe(1);
    });
    h.clock.advance(31_000);
    expect(await h.used()).toBe(1);
  }, 60_000);

  it("共同预算种子缺失不能假装已互斥，未知模板不能绕过固定键", async () => {
    const h = await setup();
    await h.prisma.smsTemplate.delete({ where: { templateKey: "verify_code" } });
    expect(await h.tx.run((client) => lockSmsBudget(client, ["account_notice"]))).toBe(false);
    await expect(h.tx.run((client) => lockSmsBudget(client, ["constructor"]))).rejects.toThrow(
      "短信预算只接受已登记的模板键",
    );
    expect(await h.prisma.notificationDelivery.count()).toBe(0);
  }, 60_000);
});
