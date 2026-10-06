import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import {
  applyReceipt,
  createPaymentHarness,
  pendingPlanOrder,
  snapshotTables,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { openPaymentException } from "./exception.js";

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: PaymentHarness;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createPaymentHarness(prisma);
}, 180_000);
async function setup(status?: "pending_payment" | "pending_confirmation") {
  const { entity } = await h.make.merchant({ verified: true });
  const order = await pendingPlanOrder(h, { entityId: entity.id, ...(status ? { status } : {}) });
  const receipt = await transferReceipt(h, order);
  return { order, receipt };
}
const ctx = (entityId: string) =>
  createIdentityContext({ actor: { type: "system", job: "lyxtest.payment" }, entityId });

describe("唯一付款入账入口", () => {
  for (const status of ["pending_payment", "pending_confirmation"] as const)
    it(`${status} 实收写入且只迁移一次；三次重放各表不变`, async () => {
      const { order, receipt } = await setup(status);
      expect((await applyReceipt(h, receipt)).result).toMatchObject({
        status: "applied",
        fulfillment: { status: "done" },
      });
      const paid = await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
      expect(paid).toMatchObject({
        status: "paid",
        transferState: null,
        paidAmountFen: receipt.channelAmountFen,
        paidAt: receipt.channelSuccessAt,
        paidPaymentTxnId: receipt.id,
        appliedAt: h.clock.now(),
        fulfillmentStatus: "done",
      });
      const operation = await prisma.ledgerOperation.findUniqueOrThrow({
        where: { opKey: `fulfill:billing_order:${order.id}` },
      });
      expect(paid.fulfilledAt).toEqual(operation.occurredAt);
      expect(
        await prisma.statusTransition.count({
          where: { machine: "billing_order", subjectId: order.id },
        }),
      ).toBe(1);
      const tables = [
        "billing_order",
        "payment_txn",
        "subscription_term",
        "grant_schedule",
        "point_lot",
        "point_ledger_entry",
        "ledger_operation",
        "outbox_event",
        "status_transition",
        "audit_log",
        "biz_sequence",
      ];
      const before = await snapshotTables(prisma, tables);
      for (let n = 0; n < 3; n++) expect((await applyReceipt(h, receipt)).replayed).toBe(true);
      expect(await snapshotTables(prisma, tables)).toEqual(before);
    });
  for (const status of ["pending_payment", "pending_confirmation"] as const)
    it(`${status} 金额不符取消并开差异，交易保持未入账`, async () => {
      const { order } = await setup(status);
      const receipt = await transferReceipt(h, order, order.amountFen - 1);
      const result = await applyReceipt(h, receipt);
      expect(result.result).toMatchObject({ status: "exception", kind: "amount_mismatch" });
      expect(await prisma.billingOrder.findUnique({ where: { id: order.id } })).toMatchObject({
        status: "cancelled",
        cancelReason: "amount_mismatch",
        transferState: null,
        paidAmountFen: 0,
        appliedAt: null,
        hasOpenException: true,
      });
      expect(await prisma.paymentTxn.findUnique({ where: { id: receipt.id } })).toMatchObject({
        appliedAt: null,
        reconState: "diff",
      });
      const exception = await prisma.paymentException.findUniqueOrThrow({
        where: { dedupeKey: `amount_mismatch:${receipt.outTradeNo}` },
      });
      expect(exception.amountFen).toBe(1);
      expect(exception.platformFact).toEqual({ status: "cancelled", amountFen: order.amountFen });
      expect(exception.billFact).not.toHaveProperty("channelPayerRef");
      expect(
        await prisma.statusTransition.count({
          where: { machine: "payment_exception", subjectId: exception.id },
        }),
      ).toBe(1);
      const before = await snapshotTables(prisma, [
        "billing_order",
        "payment_txn",
        "payment_exception",
        "status_transition",
        "outbox_event",
        "audit_log",
        "biz_sequence",
      ]);
      await applyReceipt(h, receipt);
      expect(
        await snapshotTables(prisma, [
          "billing_order",
          "payment_txn",
          "payment_exception",
          "status_transition",
          "outbox_event",
          "audit_log",
          "biz_sequence",
        ]),
      ).toEqual(before);
    });
  for (const status of ["paid", "refunded", "cancelled"] as const)
    it(`${status} 后到账分类；金额不符优先且保留原终态`, async () => {
      const { order, receipt } = await setup();
      if (status === "cancelled")
        await prisma.billingOrder.update({
          where: { id: order.id },
          data: { status, transferState: null, cancelledAt: h.clock.now(), cancelReason: "staff" },
        });
      else {
        await applyReceipt(h, receipt);
        if (status === "refunded")
          await prisma.billingOrder.update({
            where: { id: order.id },
            data: { status, refundedAt: h.clock.now(), refundedAmountFen: order.amountFen },
          });
      }
      const second = await transferReceipt(h, order);
      expect((await applyReceipt(h, second)).result).toMatchObject({
        status: "exception",
        kind: status === "cancelled" ? "paid_after_cancel" : "duplicate_receipt",
      });
      const badAmount = await transferReceipt(h, order, order.amountFen + 3);
      expect((await applyReceipt(h, badAmount)).result).toMatchObject({
        status: "exception",
        kind: "amount_mismatch",
      });
      expect(
        (await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
      ).toBe(status);
      expect(
        (await prisma.paymentTxn.findUniqueOrThrow({ where: { id: second.id } })).appliedAt,
      ).toBeNull();
    });
  it("全额退回不入账；微信或孤儿入口拒绝且无写入", async () => {
    const { order, receipt } = await setup();
    await prisma.paymentTxn.update({
      where: { id: receipt.id },
      data: { refundedFen: order.amountFen },
    });
    expect((await applyReceipt(h, receipt)).result.status).toBe("skipped");
    const orphan = await h.make.paymentTxn();
    await expect(applyReceipt(h, orphan)).rejects.toMatchObject({ error: "INTERNAL" });
    const wx = await h.make.billingOrder({ status: "pending_payment" });
    const wxReceipt = await h.make.paymentTxn({
      entityId: wx.entityId,
      billingOrderId: wx.id,
      amountFen: wx.amountFen,
    });
    await expect(applyReceipt(h, wxReceipt)).rejects.toMatchObject({ error: "INTERNAL" });
    expect((await prisma.billingOrder.findUniqueOrThrow({ where: { id: wx.id } })).status).toBe(
      "pending_payment",
    );
  });
  it("同去重键旧差异已处理时不重新开单、不复活标记", async () => {
    const { order } = await setup();
    const receipt = await transferReceipt(h, order, order.amountFen + 1);
    const r = await applyReceipt(h, receipt);
    if (r.result.status !== "exception") throw new Error("应为差异");
    await prisma.paymentException.update({
      where: { id: r.result.paymentExceptionId },
      data: {
        status: "ignored",
        resolutionNote: "测试核销",
        resolvedAt: h.clock.now(),
        resolvedByStaffId: receipt.confirmedByStaffId,
      },
    });
    await prisma.billingOrder.update({
      where: { id: order.id },
      data: { hasOpenException: false },
    });
    const before = await snapshotTables(prisma, [
      "payment_exception",
      "outbox_event",
      "status_transition",
      "audit_log",
      "biz_sequence",
    ]);
    await h.tx.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM billing_order WHERE id = ${order.id}::uuid FOR UPDATE`;
      await openPaymentException(tx, h.paymentDeps, ctx(order.entityId), {
        kind: "amount_mismatch",
        order,
        receipt,
      });
    });
    expect(
      await snapshotTables(prisma, [
        "payment_exception",
        "outbox_event",
        "status_transition",
        "audit_log",
        "biz_sequence",
      ]),
    ).toEqual(before);
    expect(
      (await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).hasOpenException,
    ).toBe(false);
  });
  it("入账或金额不符后只取消本单未触发的 po.transfer_ttl", async () => {
    for (const mismatch of [false, true]) {
      const { order } = await setup();
      const receipt = await transferReceipt(h, order, order.amountFen + (mismatch ? 1 : 0));
      const own = await prisma.timer.create({
        data: {
          id: uuidv7(),
          kind: "po.transfer_ttl",
          subjectType: "billing_order",
          subjectId: order.id,
          entityId: order.entityId,
          dedupeKey: `lyxtest:${order.id}`,
          fireAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      const untouched = await prisma.timer.create({
        data: {
          id: uuidv7(),
          kind: "po.transfer_ttl",
          subjectType: "billing_order",
          subjectId: uuidv7(),
          entityId: order.entityId,
          dedupeKey: `lyxtest:other:${order.id}`,
          fireAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      await applyReceipt(h, receipt);
      expect((await prisma.timer.findUniqueOrThrow({ where: { id: own.id } })).status).toBe(
        "cancelled",
      );
      expect((await prisma.timer.findUniqueOrThrow({ where: { id: untouched.id } })).status).toBe(
        "scheduled",
      );
    }
  });
  it("真实状态链的数据守卫拒绝缺少交易、金额不符与全额退回；不留下历史", async () => {
    const { order } = await setup();
    const bad = await transferReceipt(h, order, order.amountFen + 1);
    const equal = await transferReceipt(h, order);
    await prisma.paymentTxn.update({
      where: { id: equal.id },
      data: { refundedFen: order.amountFen },
    });
    for (const paymentTxnId of [undefined, bad.id, equal.id]) {
      await expect(
        h.tx.run((tx) =>
          h.paymentDeps.flow.transition(tx, ctx(order.entityId), {
            machine: "billing_order",
            stateField: "status",
            id: order.id,
            event: "billing_order.confirm_transfer",
            emit: { none: true, primary: "billing_order.paid" },
            ...(paymentTxnId ? { args: { paymentTxnId } } : {}),
            set: {
              paid_amount_fen: order.amountFen,
              paid_at: h.clock.now(),
              paid_payment_txn_id: equal.id,
              applied_at: h.clock.now(),
              transfer_state: null,
            },
          }),
        ),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    }
    await expect(
      h.tx.run((tx) =>
        h.paymentDeps.flow.transition(tx, ctx(order.entityId), {
          machine: "billing_order",
          stateField: "status",
          id: order.id,
          event: "billing_order.cancel_mismatch",
          emit: { none: true, primary: "billing_order.cancelled" },
          args: { paymentTxnId: equal.id },
          reasonCode: "amount_mismatch",
          set: {
            cancelled_at: h.clock.now(),
            cancel_reason: "amount_mismatch",
            transfer_state: null,
          },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await prisma.statusTransition.count({ where: { subjectId: order.id } })).toBe(0);
    expect((await prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "pending_confirmation",
    );
  });
});
