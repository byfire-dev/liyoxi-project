import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import { assertNotInTransaction, createTxRunner, uuidv7 } from "../kernel/index.js";
import type { RecurringRunContext } from "../kernel/index.js";
import { ok } from "../providers/types.js";
import type { SmsProvider, SmsSendResult } from "../providers/types.js";
import {
  createClock,
  createFactories,
  createFakeSms,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { createSmsHealth } from "./sms-health.js";
import type { SmsHealth } from "./sms-health.js";
import { createSmsInit, SMS_FIELDS } from "./sms-init.js";

const db = useSeededDatabase("services");
const secondDb = useSeededDatabase("services", { label: "b" });
const scopes: SmsHealth[] = [];
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.close()));
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(database = db) {
  await database.reset();
  const prisma = await database.prisma();
  const clock = createClock(new Date("2026-10-08T02:20:00.000Z"));
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const staff = await createFactories({ db: prisma, clock }).staff({ staffRoleKey: "super_admin" });
  await createSmsInit({ tx, clock })({
    staffId: staff.id,
    config: {
      templates: Object.entries(SMS_FIELDS).map(([templateKey, fields], index) => ({
        templateKey,
        kind: templateKey === "verify_code" ? "verify" : "notice",
        providerTemplateId: String(1000 + index),
        signName: "虚构测试平台",
        params: fields.map(({ name, maxLen }) => ({ name, maxLen })),
        status: "active",
        approval: {
          templateApproved: true,
          signApproved: true,
          reference: "fictional-test-approval",
        },
      })),
    },
  });
  await prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "notify.test_recipients",
      value: [{ staffId: staff.id, phone: "13800138000" }],
      createdByStaffId: staff.id,
      effectiveAt: clock.now(),
      createdAt: clock.now(),
    },
  });
  await prisma.smsTemplate.updateMany({
    where: { templateKey: { not: "account_notice" } },
    data: { status: "disabled" },
  });
  clock.advance(6 * 86_400_000);
  const sms = createFakeSms({ clock });
  const health = (provider: SmsProvider = sms) => {
    const scope = createSmsHealth({
      db: prisma,
      tx,
      clock,
      config: createConfig({ db: prisma, clock, redis: null }),
      sms: provider,
      alerts: { async raise() {} },
      keyring: () => TEST_KEYRING,
      env: "test",
    });
    scopes.push(scope);
    return scope;
  };
  const context = (): {
    scheduledFor: Date;
    runTx: NonNullable<RecurringRunContext["runTx"]>;
  } => ({
    scheduledFor: clock.now(),
    runTx: tx.run.bind(tx),
  });
  return { prisma, clock, tx, staff, sms, health, context };
}

function heldProvider(base: SmsProvider) {
  const entered = latch();
  let signal: AbortSignal | undefined;
  let finish: ((result: SmsSendResult) => void) | undefined;
  let active = 0;
  let calls = 0;
  const provider: SmsProvider = {
    ...base,
    async sendTemplate(input) {
      assertNotInTransaction("测试短信发起");
      calls++;
      active++;
      signal = input.signal;
      const result = await new Promise<SmsSendResult>((resolve) => {
        let settled = false;
        finish = (outcome) => {
          if (settled) return;
          settled = true;
          input.signal?.removeEventListener("abort", abort);
          resolve(outcome);
        };
        const abort = () =>
          finish?.({
            ok: false,
            reason: "unavailable",
            message: "虚构发送应答不明",
            acceptance: "unknown",
          });
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
        entered.resolve();
      });
      active--;
      return result;
    },
  };
  return {
    provider,
    entered: entered.promise,
    signal: () => signal,
    active: () => active,
    calls: () => calls,
    release: () => finish?.(ok({ requestId: "test-request", providerMsgId: "test-message" })),
  };
}

describe("短信健康任务自身作用域与真实发前事实", () => {
  it("预取消和close后的新任务零认领、零外呼", async () => {
    const h = await setup();
    const health = h.health();
    const context = { ...h.context(), signal: AbortSignal.abort() };
    expect(await health.keepalive(context)).toEqual({ outcome: "cancelled" });
    const closing = health.close();
    expect(health.close()).toBe(closing);
    await closing;
    expect(await health.keepalive(h.context())).toEqual({ outcome: "cancelled" });
    expect(await health.balance(h.context())).toEqual({ outcome: "cancelled" });
    expect(await h.prisma.notificationDelivery.count()).toBe(0);
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(0);
  }, 60_000);

  it("close等待claim短TX收尾，已认领未发任务取消且callStartedAt仍空", async () => {
    const h = await setup();
    const claimed = latch();
    const release = latch();
    const health = h.health();
    const context = h.context();
    const run = context.runTx!;
    context.runTx = async (work) => {
      const result = await run(work);
      if (await h.prisma.notificationDelivery.count({ where: { status: "sending" } })) {
        claimed.resolve();
        await release.promise;
      }
      return result;
    };
    const job = health.keepalive(context);
    try {
      await claimed.promise;
      let closed = false;
      const closing = health.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(h.sms.callsOf("sendTemplate")).toHaveLength(0);
      release.resolve();
      await closing;
      expect(await job).toMatchObject({ outcome: "cancelled", sent: 0 });
      expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
        status: "cancelled",
        reason: "guard_invalid",
        callStartedAt: null,
        leaseUntil: null,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([job, health.close()]);
    }
  }, 60_000);

  it("同一目标员工在claim后停用，start必须复核而不调用其他活跃员工替代", async () => {
    const h = await setup();
    await createFactories({ db: h.prisma, clock: h.clock }).staff({ staffRoleKey: "super_admin" });
    const health = h.health();
    const context = h.context();
    const run = context.runTx!;
    let changed = false;
    context.runTx = async (work) => {
      const result = await run(work);
      if (
        !changed &&
        (await h.prisma.notificationDelivery.count({ where: { status: "sending" } }))
      ) {
        changed = true;
        await h.prisma.staff.update({
          where: { id: h.staff.id },
          data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
        });
      }
      return result;
    };
    expect(await health.keepalive(context)).toMatchObject({ sent: 0, skipped: 1 });
    expect(h.sms.callsOf("sendTemplate")).toHaveLength(0);
    expect(await h.prisma.notificationDelivery.findFirst()).toMatchObject({
      status: "cancelled",
      reason: "guard_invalid",
      callStartedAt: null,
    });
  }, 60_000);

  it("关闭A只取消自身真实在途I/O，B仍等待且可成功；未知A不重发", async () => {
    const a = await setup();
    const b = await setup(secondDb);
    const aProvider = heldProvider(a.sms);
    const bProvider = heldProvider(b.sms);
    const aHealth = a.health(aProvider.provider);
    const bHealth = b.health(bProvider.provider);
    const settlementEntered = latch();
    const releaseSettlement = latch();
    const aContext = a.context();
    let heldSettlement = false;
    aContext.runTx = (work) =>
      a.tx.run(async (client) => {
        const result = await work(client);
        if (
          !heldSettlement &&
          (await client.notificationDelivery.count({ where: { status: "failed" } }))
        ) {
          heldSettlement = true;
          settlementEntered.resolve();
          await releaseSettlement.promise;
        }
        return result;
      });
    const aJob = aHealth.keepalive(aContext);
    const bJob = bHealth.keepalive(b.context());
    try {
      await Promise.all([aProvider.entered, bProvider.entered]);
      let closed = false;
      const closing = aHealth.close().then(() => {
        closed = true;
      });
      await settlementEntered.promise;
      expect(closed).toBe(false);
      expect(bProvider.signal()?.aborted).toBe(false);
      releaseSettlement.resolve();
      await closing;
      expect(await aJob).toMatchObject({ outcome: "cancelled", failed: 1 });
      expect(aProvider.signal()?.aborted).toBe(true);
      expect(aProvider.active()).toBe(0);
      expect(bProvider.signal()?.aborted).toBe(false);
      expect(bProvider.active()).toBe(1);
      bProvider.release();
      expect(await bJob).toMatchObject({ outcome: "completed", sent: 1 });
      expect(await a.prisma.notificationDelivery.findFirst()).toMatchObject({
        status: "failed",
        reason: "unknown_outcome",
        leaseUntil: null,
      });
      expect(await b.prisma.notificationDelivery.findFirst()).toMatchObject({
        status: "sent",
        providerMsgId: "test-message",
        leaseUntil: null,
      });
      expect(await aHealth.keepalive(a.context())).toEqual({ outcome: "cancelled" });
      expect(aProvider.calls()).toBe(1);
      expect(bProvider.calls()).toBe(1);
      expect(bProvider.active()).toBe(0);
    } finally {
      releaseSettlement.resolve();
      aProvider.release();
      bProvider.release();
      await Promise.allSettled([aJob, bJob, aHealth.close(), bHealth.close()]);
    }
  }, 60_000);
});
