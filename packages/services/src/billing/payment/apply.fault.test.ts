import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, isAppError } from "../../kernel/index.js";
import {
  applyReceipt,
  createPaymentHarness,
  dumpLedger,
  fulfillOrder,
  joinPayment,
  pendingPlanOrder,
  snapshotTables,
  topUp,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { ACCOUNT_LOCK_WAIT_MS } from "../ledger/index.js";
import { FULFILL_STEPS } from "../subscription/types.js";
import type { FulfillStep } from "../subscription/types.js";
import { APPLY_STEPS } from "./types.js";
import type { ApplyStep } from "./types.js";

const SLOW = 240_000;
const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: PaymentHarness;
let other: Awaited<ReturnType<typeof joinPayment>>;
let fault: { at: number; error: () => Error } | null = null;
let outerFault: ApplyStep | null = null;
let forceBlocked = false;
let seen: FulfillStep[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma, {
    onStep: (step) => {
      seen.push(step);
      if (forceBlocked) throw new AppError("QUOTE_CHANGED");
      if (fault !== null && seen.length === fault.at) throw fault.error();
    },
    onApplyStep: (step) => {
      if (step === outerFault) throw new Error(`入账外层 ${step}`);
    },
  });
  other = await joinPayment(h, await db.url());
}, SLOW);
afterAll(async () => {
  await other?.close();
});

async function pending() {
  const { entity, store } = await h.make.merchant({ verified: true });
  const order = await pendingPlanOrder(h, { entityId: entity.id });
  return { entity, store, order, receipt: await transferReceipt(h, order) };
}
async function expired() {
  h.clock.set(new Date("2026-01-05T12:00:00+08:00"));
  const first = await pending();
  await applyReceipt(h, first.receipt);
  await topUp(h, { entityId: first.entity.id, points: 1000 });
  const order = await pendingPlanOrder(h, { entityId: first.entity.id, months: 3 });
  const revisionId = (order.contentSnapshot as { planRevisionId: string }).planRevisionId;
  await prisma.billingOrder.update({
    where: { id: order.id },
    data: {
      contentSnapshot: {
        ...(order.contentSnapshot as object),
        promo: {
          claimRevisionId: revisionId,
          type: "previous_revision",
          appliedRevisionId: revisionId,
        },
      },
    },
  });
  return { entity: first.entity, order, receipt: await transferReceipt(h, order) };
}
async function expectBlocked(orderId: string, receiptId: string) {
  expect(await prisma.billingOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
    status: "paid",
    paidPaymentTxnId: receiptId,
    fulfillmentStatus: "blocked",
    fulfilledAt: null,
    hasOpenException: true,
  });
  expect(
    (await prisma.paymentTxn.findUniqueOrThrow({ where: { id: receiptId } })).appliedAt,
  ).not.toBeNull();
  expect(
    await prisma.paymentException.findMany({
      where: { billingOrderId: orderId, kind: "fulfillment_blocked", status: "open" },
    }),
  ).toHaveLength(1);
  expect(
    await prisma.outboxEvent.count({
      where: { aggregateId: orderId, eventType: "billing_order.fulfillment_blocked" },
    }),
  ).toBe(1);
}

describe("真实付款入口的故障注入（验收 2、3）", () => {
  it(
    "履约每一次写入后故障：付款提交、账本回滚、开未决差异；修好后直接重试 fulfill 成功",
    async () => {
      const control = await expired();
      h.clock.set(new Date("2026-02-10T10:00:00+08:00"));
      seen = [];
      expect((await applyReceipt(h, control.receipt)).result).toMatchObject({
        fulfillment: { status: "done" },
      });
      const trace = [...seen];
      expect(new Set(trace)).toEqual(new Set(FULFILL_STEPS));
      expect(trace.length).toBeGreaterThan(20);
      const reasons = new Set<string>();
      for (let at = 1; at <= trace.length; at++) {
        fault = null;
        const victim = await expired();
        h.clock.set(new Date("2026-02-10T10:00:00+08:00"));
        const before = await dumpLedger(prisma, victim.entity.id);
        fault = { at, error: () => new Error(`履约写入 ${at}`) };
        seen = [];
        const outcome = await applyReceipt(h, victim.receipt);
        if (outcome.result.status !== "applied" || outcome.result.fulfillment.status !== "blocked")
          throw new Error(`第${at}步应受阻`);
        reasons.add(outcome.result.fulfillment.reasonCode);
        await expectBlocked(victim.order.id, victim.receipt.id);
        expect(await dumpLedger(prisma, victim.entity.id)).toEqual(before);
        // 入账重放不能自动处理差异；原 blocked 结果保持不变。
        expect(await applyReceipt(h, victim.receipt)).toEqual({
          result: outcome.result,
          replayed: true,
        });
        fault = null;
        expect((await fulfillOrder(h, victim.order)).result.status).toBe("done");
        expect(await dumpLedger(prisma, victim.entity.id)).toEqual(
          await dumpLedger(prisma, control.entity.id),
        );
      }
      expect(reasons).toEqual(new Set(["ADVANCE_FAILED", "UNEXPECTED"]));
    },
    SLOW,
  );

  it(
    "业务错误、真实唯一冲突、真实自检失败均只回滚保存点",
    async () => {
      const business = await pending();
      forceBlocked = true;
      expect((await applyReceipt(h, business.receipt)).result).toMatchObject({
        fulfillment: { status: "blocked" },
      });
      forceBlocked = false;
      await expectBlocked(business.order.id, business.receipt.id);
      expect(await prisma.subscriptionTerm.count({ where: { entityId: business.entity.id } })).toBe(
        0,
      );
      expect((await fulfillOrder(h, business.order)).result.status).toBe("done");

      const unique = await pending();
      const stray = await h.make.subscriptionTerm({
        entityId: unique.entity.id,
        termNo: 9,
        status: "cancelled",
        sourceBillingOrderId: unique.order.id,
      });
      expect((await applyReceipt(h, unique.receipt)).result).toMatchObject({
        fulfillment: {
          status: "blocked",
          reasonCode: "CONSTRAINT_VIOLATION",
          detail: { sqlState: "23505" },
        },
      });
      await expectBlocked(unique.order.id, unique.receipt.id);
      expect(await prisma.pointLot.count({ where: { entityId: unique.entity.id } })).toBe(0);
      expect(await prisma.ledgerOperation.count({ where: { entityId: unique.entity.id } })).toBe(0);
      await prisma.subscriptionTerm.delete({ where: { id: stray.id } });
      expect((await fulfillOrder(h, unique.order)).result.status).toBe("done");

      const self = await pending();
      const drift = await h.make.subscribedMerchant();
      const hold = await h.make.pointHold({ entityId: drift.entity.id, storeId: drift.store.id });
      await prisma.pointHold.update({
        where: { id: hold.id },
        data: { entityId: self.entity.id, storeId: self.store.id },
      });
      expect((await applyReceipt(h, self.receipt)).result).toMatchObject({
        fulfillment: { status: "blocked", reasonCode: "SELF_CHECK_FAILED" },
      });
      await expectBlocked(self.order.id, self.receipt.id);
      expect(await prisma.pointLot.count({ where: { entityId: self.entity.id } })).toBe(0);
      expect(await prisma.ledgerOperation.count({ where: { entityId: self.entity.id } })).toBe(0);
      await prisma.pointHold.delete({ where: { id: hold.id } });
      expect((await fulfillOrder(h, self.order)).result.status).toBe("done");
    },
    SLOW,
  );

  it(
    "可重试死锁重新执行整个入账：第二遍成功，无受阻单且只履约一次",
    async () => {
      const victim = await pending();
      seen = [];
      fault = {
        at: 2,
        error: () =>
          Object.assign(new Error("deadlock detected"), {
            name: "DriverAdapterError",
            cause: { originalCode: "40P01", originalMessage: "deadlock detected" },
          }),
      };
      let bodies = 0;
      const outcome = await h.tx.run(async (tx) => {
        bodies++;
        return h.payment.applyPayment(tx, { paymentTxnId: victim.receipt.id });
      });
      fault = null;
      expect(bodies).toBe(2);
      expect(outcome.result).toMatchObject({ fulfillment: { status: "done" } });
      expect(
        await prisma.paymentException.count({ where: { billingOrderId: victim.order.id } }),
      ).toBe(0);
      expect(
        await prisma.ledgerOperation.count({
          where: { entityId: victim.entity.id, opType: "fulfill" },
        }),
      ).toBe(1);
    },
    SLOW,
  );

  it(
    "账户锁被占约3秒：ACCOUNT_BUSY 整体回滚收款与付款事实；释放后成功",
    async () => {
      const victim = await pending();
      const tables = [
        "billing_order",
        "payment_txn",
        "billing_account",
        "status_transition",
        "outbox_event",
        "audit_log",
        "biz_sequence",
        "payment_exception",
      ];
      const before = await snapshotTables(prisma, tables);
      let locked!: () => void;
      let release!: () => void;
      const lockedAt = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = other.tx.run(
        async (tx) => {
          await other.ledger.lockAccount(tx, victim.entity.id);
          locked();
          await released;
        },
        { timeoutMs: 30_000 },
      );
      await lockedAt;
      const began = performance.now();
      let outcome: unknown;
      try {
        outcome = await applyReceipt(h, victim.receipt).catch((error: unknown) => error);
      } finally {
        release();
        await holder;
      }
      expect(isAppError(outcome) && outcome.error).toBe("ACCOUNT_BUSY");
      expect(performance.now() - began).toBeGreaterThanOrEqual(ACCOUNT_LOCK_WAIT_MS - 100);
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect((await applyReceipt(h, victim.receipt)).result).toMatchObject({
        fulfillment: { status: "done" },
      });
    },
    SLOW,
  );

  it(
    "保存点以外每个付款写步骤抛错，全部回滚；没有半入账或半开差异单",
    async () => {
      for (const step of APPLY_STEPS) {
        const victim = await pending();
        forceBlocked = step === "exception.open";
        outerFault = step;
        const tables = [
          "billing_order",
          "payment_txn",
          "billing_account",
          "subscription_term",
          "grant_schedule",
          "point_lot",
          "point_ledger_entry",
          "ledger_operation",
          "subscription_event",
          "payment_exception",
          "status_transition",
          "outbox_event",
          "audit_log",
          "biz_sequence",
          "timer",
        ];
        const before = await snapshotTables(prisma, tables);
        await expect(applyReceipt(h, victim.receipt)).rejects.toThrow(`入账外层 ${step}`);
        outerFault = null;
        forceBlocked = false;
        expect(await snapshotTables(prisma, tables)).toEqual(before);
        expect((await applyReceipt(h, victim.receipt)).result).toMatchObject({
          fulfillment: { status: "done" },
        });
      }
    },
    SLOW,
  );
});
