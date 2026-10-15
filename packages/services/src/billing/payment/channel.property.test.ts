import fc from "fast-check";
import type { BillingOrder, PaymentTxn, PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, createIdentityContext } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import {
  applyReceipt,
  createPaymentHarness,
  fulfillOrder,
  joinPayment,
  pendingPlanOrder,
  pendingWechatReceipt,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";
import { subscriptionInvariants } from "../subscription/invariants.js";
import { paymentInvariants } from "./invariants.js";
import { purchaseInvariants } from "./purchase-registration.js";
import { recordChannelSuccess } from "./channel-success.js";
import type { ApplyStep } from "./types.js";
import type { FulfillStep } from "../subscription/types.js";

const db = useSeededDatabase("services");
const tables = [
  "billing_order",
  "payment_txn",
  "payment_exception",
  "billing_account",
  "ledger_operation",
  "point_ledger_entry",
  "point_lot",
  "subscription_term",
  "grant_schedule",
  "subscription_event",
  "outbox_event",
  "status_transition",
  "audit_log",
  "biz_sequence",
  "timer",
];
const appid = "wx0000000000000000",
  mchid = "1900000109",
  seed = 42;
let prisma: PrismaClient, h: PaymentHarness;
let left: Awaited<ReturnType<typeof joinPayment>>, right: Awaited<ReturnType<typeof joinPayment>>;
let gate: ReturnType<typeof barrier> | null = null,
  outerFault: ApplyStep | null = null,
  businessFault: FulfillStep | null = null;
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, released, enter, release };
}
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma);
  left = await joinPayment(h, await db.url(), {
    onApplyStep: async (step) => {
      if (step === outerFault) throw new AppError("ACCOUNT_BUSY");
      if (gate && step === "txn.apply") {
        gate.enter();
        await gate.released;
      }
    },
    onStep: (step) => {
      if (step === businessFault) throw new AppError("QUOTE_CHANGED");
    },
  });
  right = await joinPayment(h, await db.url());
}, 90_000);
afterAll(async () => {
  gate?.release();
  await Promise.all([left?.close(), right?.close()]);
});
const identity = (entityId: string) =>
  createIdentityContext({ actor: { type: "system", job: "lyxtest.channel_property" }, entityId });
async function pending(amountFen = 10001, months = 3) {
  const { entity } = await h.make.merchant({ verified: true });
  const order = await pendingPlanOrder(h, {
    entityId: entity.id,
    channel: "wechat_jsapi",
    amountFen,
    months,
  });
  return { entity, order, receipt: await pendingWechatReceipt(h, order) };
}
function record(tx: Tx, order: BillingOrder, receipt: PaymentTxn, amountFen = order.amountFen) {
  return recordChannelSuccess(tx, { ...h.paymentDeps, appid, mchid }, identity(order.entityId), {
    paymentTxnId: receipt.id,
    transaction: {
      appid,
      mchid,
      outTradeNo: receipt.outTradeNo,
      tradeState: "SUCCESS",
      transactionId: `wx_${receipt.id}`,
      amountFen,
      payerOpenid: receipt.payerOpenid!,
      attach: receipt.attach!,
      successAt: receipt.createdAt,
    },
  });
}
async function paidFact(order: BillingOrder, receipt: PaymentTxn, amountFen = order.amountFen) {
  await h.tx.run((tx) => record(tx, order, receipt, amountFen));
}
async function pid(tx: Tx) {
  return (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
}
async function blockedBy(waiter: number, holder: number) {
  const deadline = performance.now() + 5000;
  for (;;) {
    const [row] = await prisma.$queryRaw<
      { blocked: boolean }[]
    >`SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;
    if (row?.blocked) return;
    if (performance.now() >= deadline) throw new Error("真实第二连接未到达付款单锁屏障");
  }
}
async function invariants(entityId: string) {
  for (const rule of [
    ...billingInvariants,
    ...subscriptionInvariants,
    ...paymentInvariants,
    ...purchaseInvariants.filter((rule) => rule.code === "payment.I12"),
  ])
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [entityId] }, { now: h.clock.now() })),
      rule.code,
    ).toEqual([]);
}
async function moneyModel(order: BillingOrder, receipt: PaymentTxn, months: number) {
  const paid = await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
  expect(paid).toMatchObject({
    status: "paid",
    paidPaymentTxnId: receipt.id,
    paidAmountFen: order.amountFen,
    paidAt: receipt.createdAt,
    appliedAt: h.clock.now(),
    fulfillmentStatus: "done",
  });
  expect(
    await prisma.paymentTxn.count({
      where: { billingOrderId: order.id, appliedAt: { not: null } },
    }),
  ).toBe(1);
  const term = await prisma.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: order.id },
  });
  const schedules = await prisma.grantSchedule.findMany({
    where: { subscriptionTermId: term.id },
    orderBy: { monthNo: "asc" },
  });
  expect(schedules).toHaveLength(months);
  // 独立整数模型：前月向下取整，尾月收余数；不调用待测分摊或fulfill实现。
  const share = Math.floor(order.amountFen / months);
  expect(schedules.map((row) => row.valueFen)).toEqual(
    Array.from({ length: months }, (_, index) =>
      index === months - 1 ? order.amountFen - share * (months - 1) : share,
    ),
  );
  const first = await prisma.pointLot.findUniqueOrThrow({
    where: { id: schedules[0]!.pointLotId! },
  });
  expect(first).toMatchObject({
    costBasisFen: months === 1 ? order.amountFen : share,
    originalQty: 6600,
  });
  expect(
    await prisma.ledgerOperation.count({ where: { entityId: order.entityId, opType: "fulfill" } }),
  ).toBe(1);
  expect(
    await prisma.outboxEvent.count({
      where: { aggregateId: order.id, eventType: "billing_order.paid" },
    }),
  ).toBe(1);
  expect(
    await prisma.statusTransition.count({
      where: { machine: "billing_order", subjectId: order.id },
    }),
  ).toBe(1);
}

describe("W4-03 微信唯一入账低量性质与真实屏障", { timeout: 90_000 }, () => {
  it("seed42三轮：同款/不同成功款/金额差异被真实行锁串行；不同主体不被该锁阻塞", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amountFen: fc.integer({ min: 3, max: 100003 }),
          months: fc.constantFrom(1, 3),
        }),
        async ({ amountFen, months }) => {
          for (const mode of ["same", "duplicate", "mismatch", "different"] as const) {
            const first = await pending(amountFen, months);
            await paidFact(first.order, first.receipt);
            const other = mode === "different" ? await pending(amountFen, months) : first;
            const secondReceipt =
              mode === "same"
                ? first.receipt
                : mode === "different"
                  ? other.receipt
                  : await pendingWechatReceipt(h, first.order, 2);
            if (mode !== "same")
              await paidFact(other.order, secondReceipt, amountFen + (mode === "mismatch" ? 1 : 0));
            h.clock.advance(1);
            const held = barrier();
            gate = held;
            let firstPid = 0,
              secondPid = 0;
            const firstApply = left.tx.run(async (tx) => {
              firstPid = await pid(tx);
              return left.payment.applyPayment(tx, { paymentTxnId: first.receipt.id });
            });
            let secondApply: ReturnType<typeof applyReceipt> | undefined;
            try {
              await Promise.race([
                held.entered,
                firstApply.then(() => {
                  throw new Error("首事务未经过入账位屏障");
                }),
              ]);
              const begun = barrier();
              secondApply = right.tx.run(async (tx) => {
                secondPid = await pid(tx);
                begun.enter();
                return right.payment.applyPayment(tx, { paymentTxnId: secondReceipt.id });
              });
              await Promise.race([
                begun.entered,
                secondApply.then(() => {
                  throw new Error("第二事务未进入真实连接屏障");
                }),
              ]);
              expect(firstPid).not.toBe(secondPid);
              if (mode === "different") {
                expect((await secondApply).result).toMatchObject({
                  status: "applied",
                  fulfillment: { status: "done" },
                });
                expect(
                  (await prisma.billingOrder.findUniqueOrThrow({ where: { id: first.order.id } }))
                    .status,
                ).toBe("pending_payment");
              } else await blockedBy(secondPid, firstPid);
            } finally {
              held.release();
              gate = null;
              await Promise.allSettled([firstApply, ...(secondApply ? [secondApply] : [])]);
            }
            const winner = await firstApply,
              follower = await secondApply!;
            expect(winner).toMatchObject({
              replayed: false,
              result: { status: "applied", fulfillment: { status: "done" } },
            });
            if (mode === "same")
              expect(follower).toEqual({ result: winner.result, replayed: true });
            else if (mode !== "different") {
              expect(follower.result).toMatchObject({
                status: "exception",
                kind: mode === "mismatch" ? "amount_mismatch" : "duplicate_receipt",
              });
              expect(
                (await prisma.paymentTxn.findUniqueOrThrow({ where: { id: secondReceipt.id } }))
                  .appliedAt,
              ).toBeNull();
              expect(
                await prisma.paymentException.findFirstOrThrow({
                  where: { paymentTxnId: secondReceipt.id },
                }),
              ).toMatchObject({ amountFen: mode === "mismatch" ? 1 : amountFen, status: "open" });
            }
            await moneyModel(first.order, first.receipt, months);
            if (mode === "different") {
              await moneyModel(other.order, secondReceipt, months);
              await invariants(other.entity.id);
            }
            const settled = await snapshotTables(prisma, tables);
            await paidFact(first.order, first.receipt); // 延迟/重复的可信事实不得刷新资金行或事件。
            expect(await applyReceipt(right, first.receipt)).toEqual({
              result: winner.result,
              replayed: true,
            });
            expect(await snapshotTables(prisma, tables)).toEqual(settled);
            await invariants(first.entity.id);
          }
        },
      ),
      { seed, numRuns: 3, endOnFailure: true },
    );
  });

  it("渠道提交前、入账位、履约后及提交前中断：已提交成功保留，未提交事务逐表回滚并可重驱", async () => {
    const initial = await pending();
    let before = await snapshotTables(prisma, tables);
    await expect(
      h.tx.run(async (tx) => {
        await record(tx, initial.order, initial.receipt);
        throw new AppError("ACCOUNT_BUSY");
      }),
    ).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
    expect(await snapshotTables(prisma, tables)).toEqual(before);
    await paidFact(initial.order, initial.receipt);
    for (const point of ["txn.apply", "order.fulfill", "before.commit"] as const) {
      const victim = point === "txn.apply" ? initial : await pending();
      if (victim !== initial) await paidFact(victim.order, victim.receipt);
      before = await snapshotTables(prisma, tables);
      outerFault = point === "before.commit" ? null : point;
      try {
        await expect(
          left.tx.run(async (tx) => {
            await left.payment.applyPayment(tx, { paymentTxnId: victim.receipt.id });
            if (point === "before.commit") throw new AppError("ACCOUNT_BUSY");
          }),
        ).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
      } finally {
        outerFault = null;
      }
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(
        await prisma.paymentTxn.findUniqueOrThrow({ where: { id: victim.receipt.id } }),
      ).toMatchObject({ status: "succeeded", appliedAt: null });
      expect((await applyReceipt(right, victim.receipt)).result).toMatchObject({
        status: "applied",
        fulfillment: { status: "done" },
      });
      await moneyModel(victim.order, victim.receipt, 3);
      await invariants(victim.entity.id);
    }
  });

  it("保存点三个实际写点业务拒绝只留paid/blocked；重放冻结结果，显式fulfill恢复账本且不重收", async () => {
    for (const point of ["schedule.insert", "entry.insert", "event.emit"] as const) {
      const victim = await pending();
      await paidFact(victim.order, victim.receipt);
      businessFault = point;
      let outcome;
      try {
        outcome = await applyReceipt(left, victim.receipt);
      } finally {
        businessFault = null;
      }
      expect(outcome.result).toMatchObject({
        status: "applied",
        fulfillment: { status: "blocked" },
      });
      expect(
        await prisma.billingOrder.findUniqueOrThrow({ where: { id: victim.order.id } }),
      ).toMatchObject({
        status: "paid",
        paidPaymentTxnId: victim.receipt.id,
        fulfillmentStatus: "blocked",
        hasOpenException: true,
      });
      expect(await prisma.subscriptionTerm.count({ where: { entityId: victim.entity.id } })).toBe(
        0,
      );
      expect(await prisma.pointLedgerEntry.count({ where: { entityId: victim.entity.id } })).toBe(
        0,
      );
      expect(await prisma.ledgerOperation.count({ where: { entityId: victim.entity.id } })).toBe(0);
      const settled = await snapshotTables(prisma, tables);
      expect(await applyReceipt(right, victim.receipt)).toEqual({
        result: outcome.result,
        replayed: true,
      });
      expect(await snapshotTables(prisma, tables)).toEqual(settled);
      expect((await fulfillOrder(right, victim.order)).result.status).toBe("done");
      expect((await fulfillOrder(right, victim.order)).replayed).toBe(true);
      expect(
        await prisma.ledgerOperation.count({
          where: { entityId: victim.entity.id, opType: "fulfill" },
        }),
      ).toBe(1);
      // 差异处理及billing_order受阻字段收口仍属W4-11，不能用测试写终态冒充它。
      expect(
        (await prisma.billingOrder.findUniqueOrThrow({ where: { id: victim.order.id } }))
          .fulfillmentStatus,
      ).toBe("blocked");
      expect(
        await prisma.paymentException.count({
          where: { billingOrderId: victim.order.id, kind: "fulfillment_blocked", status: "open" },
        }),
      ).toBe(1);
      await invariants(victim.entity.id);
    }
  });
});
