import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyReceipt,
  assembleForTest,
  createPaymentHarness,
  pendingPlanOrder,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { billingInvariants } from "../invariants.js";
import { subscriptionInvariants } from "../subscription/invariants.js";
import { paymentInvariants } from "./invariants.js";

const SLOW = 180_000;
const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: PaymentHarness;
let blocked = false;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma, {
    onStep: () => {
      if (blocked) throw new Error("测试受阻");
    },
  });
}, SLOW);
async function setup(paid = true) {
  const { entity } = await h.make.merchant({ verified: true });
  const order = await pendingPlanOrder(h, { entityId: entity.id });
  const receipt = await transferReceipt(h, order);
  if (paid) await applyReceipt(h, receipt);
  return { entity, order, receipt };
}
async function run(code: string, entityId?: string, now = h.clock.now()) {
  const check = paymentInvariants.find((item) => item.code === code)!.run!;
  return h.tx.run((tx) => check(tx, entityId ? { entityIds: [entityId] } : {}, { now }));
}

describe("付款的每日不变量（验收 11）", () => {
  it(
    "三条 P1、只每日 full、不自愈；空库加种子十八条全量为零，真实入账后仍为零",
    async () => {
      expect(
        paymentInvariants.map((check) => [check.code, check.severity, check.modes, check.heal]),
      ).toEqual([
        ["payment.I1", "P1", ["full"], "none"],
        ["payment.I2", "P1", ["full"], "none"],
        ["payment.I4", "P1", ["full"], "none"],
      ]);
      const full = [...billingInvariants, ...subscriptionInvariants, ...paymentInvariants];
      const registered = assembleForTest({ entry: "worker" }).invariants;
      expect(
        registered.filter((check) => full.some((item) => item.code === check.code)),
      ).toHaveLength(18);
      expect(full.map((check) => check.code).sort()).toEqual([
        "billing.I1",
        "billing.I10",
        "billing.I11",
        "billing.I12",
        "billing.I13",
        "billing.I15",
        "billing.I16",
        "billing.I2",
        "billing.I3",
        "billing.I4",
        "billing.I5",
        "billing.I6",
        "billing.I7",
        "billing.I8",
        "billing.I9",
        "payment.I1",
        "payment.I2",
        "payment.I4",
      ]);
      for (const check of full)
        expect(
          await h.tx.run((tx) => check.run!(tx, {}, { now: h.clock.now() })),
          check.code,
        ).toEqual([]);
      await setup();
      for (const check of full)
        expect(
          await h.tx.run((tx) => check.run!(tx, {}, { now: h.clock.now() })),
          check.code,
        ).toEqual([]);
    },
    SLOW,
  );

  it(
    "I1：已支付实付漂移、指错入账交易、未终结履约，以及非已支付却已有入账都能查出",
    async () => {
      const a = await setup();
      await prisma.billingOrder.update({
        where: { id: a.order.id },
        data: { paidAmountFen: { increment: 1 } },
      });
      expect(await run("payment.I1", a.entity.id)).toMatchObject([
        { subject: { type: "billing_order", id: a.order.id } },
      ]);
      const b = await setup();
      const extra = await transferReceipt(h, b.order);
      await prisma.billingOrder.update({
        where: { id: b.order.id },
        data: { paidPaymentTxnId: extra.id },
      });
      expect(await run("payment.I1", b.entity.id)).toHaveLength(1);
      const c = await setup();
      await prisma.billingOrder.update({
        where: { id: c.order.id },
        data: { fulfillmentStatus: "none", fulfilledAt: null },
      });
      expect(await run("payment.I1", c.entity.id)).toHaveLength(1);
      const d = await setup();
      await prisma.billingOrder.update({
        where: { id: d.order.id },
        data: {
          status: "pending_confirmation",
          transferState: "proof_submitted",
          paidAmountFen: 0,
          paidAt: null,
          paidPaymentTxnId: null,
          appliedAt: null,
          fulfillmentStatus: "none",
          fulfilledAt: null,
        },
      });
      expect(await run("payment.I1", d.entity.id)).toHaveLength(1);
      expect(await run("payment.I2", d.entity.id)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "I2：待确认名下成功收款；未入账超过10分钟且无未决差异，含无主体孤儿与全额退回豁免",
    async () => {
      const a = await setup(false);
      expect(await run("payment.I2", a.entity.id)).toMatchObject([
        { subject: { type: "billing_order", id: a.order.id } },
      ]);
      await prisma.billingOrder.update({
        where: { id: a.order.id },
        data: {
          status: "cancelled",
          transferState: null,
          cancelledAt: h.clock.now(),
          cancelReason: "staff",
        },
      });
      expect(
        await run("payment.I2", a.entity.id, new Date(h.clock.now().getTime() + 10 * 60_000)),
      ).toEqual([]);
      expect(
        await run("payment.I2", a.entity.id, new Date(h.clock.now().getTime() + 10 * 60_000 + 1)),
      ).toMatchObject([{ subject: { type: "payment_txn", id: a.receipt.id } }]);
      const orphan = await h.make.paymentTxn({ entityId: null });
      const later = new Date(h.clock.now().getTime() + 11 * 60_000);
      const found = (await run("payment.I2", undefined, later)).find(
        (row) => row.subject !== undefined && "id" in row.subject && row.subject.id === orphan.id,
      );
      expect(found).toMatchObject({ subject: { type: "payment_txn", id: orphan.id } });
      expect(found).not.toHaveProperty("entityId");
      await prisma.paymentTxn.update({
        where: { id: orphan.id },
        data: { refundedFen: orphan.channelAmountFen! },
      });
      expect(
        (await run("payment.I2", undefined, later)).some(
          (row) => row.subject !== undefined && "id" in row.subject && row.subject.id === orphan.id,
        ),
      ).toBe(false);
    },
    SLOW,
  );

  it(
    "I4：受阻无未决单、超过72小时均违规；已经退款豁免",
    async () => {
      blocked = true;
      const a = await setup();
      const b = await setup();
      blocked = false;
      expect(await run("payment.I4", a.entity.id)).toEqual([]);
      const exception = await prisma.paymentException.findFirstOrThrow({
        where: { billingOrderId: a.order.id, kind: "fulfillment_blocked" },
      });
      await prisma.paymentException.update({
        where: { id: exception.id },
        data: {
          status: "ignored",
          resolutionNote: "测试关闭",
          resolvedAt: h.clock.now(),
          resolvedByStaffId: a.receipt.confirmedByStaffId,
        },
      });
      expect(await run("payment.I4", a.entity.id)).toMatchObject([
        {
          subject: { type: "billing_order", id: a.order.id },
          detail: { problem: "missing_exception" },
        },
      ]);
      const at72 = new Date(h.clock.now().getTime() + 72 * 60 * 60_000);
      expect(await run("payment.I4", b.entity.id, at72)).toEqual([]);
      expect(await run("payment.I4", b.entity.id, new Date(at72.getTime() + 1))).toMatchObject([
        { detail: { problem: "blocked_overdue" } },
      ]);
      await prisma.billingOrder.update({
        where: { id: b.order.id },
        data: { status: "refunded", refundedAt: at72, refundedAmountFen: b.order.amountFen },
      });
      expect(await run("payment.I4", b.entity.id, new Date(at72.getTime() + 1))).toEqual([]);
    },
    SLOW,
  );
});
