// h01 2.6：先查、冲突不插入；只有实际新建才写历史、事件与标记。调用方已锁付款单和交易。
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { WechatPayTransaction } from "../../providers/types.js";
import type { PaymentDeps, PaymentExceptionKind } from "./types.js";

const CAUSES = {
  status_mismatch: "渠道成功事实与既存收款不一致",
  bill_only: "成功收款没有对应付款单",
  bank_unmatched: "对公收款没有对应付款单",
  payer_mismatch: "付款人与下单记录不符",
  amount_mismatch: "实收与应付不符",
  duplicate_receipt: "重复收款",
  paid_after_cancel: "取消后收到款",
  fulfillment_blocked: "已支付但履约受阻",
} as const;
export async function openPaymentException(
  tx: Tx,
  deps: Pick<PaymentDeps, "clock" | "bizNo" | "flow">,
  ctx: IdentityContext,
  input: {
    kind: PaymentExceptionKind;
    order: BillingOrder | null;
    receipt: PaymentTxn;
    detectedBy?: "apply" | "callback" | "query";
    healed?: boolean;
    channelFact?: WechatPayTransaction;
  },
): Promise<string> {
  const { kind, order, receipt } = input;
  const dedupeKey = `${kind}:${receipt.outTradeNo}`;
  const prior = await tx.paymentException.findUnique({ where: { dedupeKey } });
  if (prior !== null) return prior.id;
  const now = deps.clock.now();
  const healed = input.healed === true;
  const amountFen =
    kind === "amount_mismatch"
      ? Math.abs((receipt.channelAmountFen ?? 0) - (order?.amountFen ?? 0))
      : receipt.channelAmountFen!;
  const id = uuidv7();
  const { count } = await tx.paymentException.createMany({
    data: [
      {
        id,
        exceptionNo: await deps.bizNo.next(tx, "CY"),
        entityId: order?.entityId ?? receipt.entityId,
        kind,
        detectedBy: input.detectedBy ?? "apply",
        billDate: new Date(`${calendarDate(now)}T00:00:00.000Z`),
        billingOrderId: order?.id ?? null,
        paymentTxnId: receipt.id,
        amountFen,
        billFact: {
          channelTxnNo: input.channelFact?.transactionId ?? receipt.channelTxnNo,
          amountFen: input.channelFact?.amountFen ?? receipt.channelAmountFen,
          status: input.channelFact?.tradeState ?? receipt.status,
          successAt:
            (input.channelFact?.successAt ?? receipt.channelSuccessAt)?.toISOString() ?? null,
        },
        platformFact: order
          ? { status: order.status, amountFen: order.amountFen }
          : { missingOrder: true },
        causeText: CAUSES[kind],
        status: healed ? "auto_healed" : "open",
        resolution: "none",
        dedupeKey,
        resolvedAt: healed ? now : null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) {
    const existing = await tx.paymentException.findUniqueOrThrow({ where: { dedupeKey } });
    return existing.id;
  }
  await deps.flow.transition(tx, ctx, {
    machine: "payment_exception",
    stateField: "status",
    id,
    event: healed ? "payment_exception.record_healed" : "payment_exception.open",
    created: true,
    ...(order
      ? { entityId: order.entityId, storeId: order.storeId }
      : receipt.entityId
        ? { entityId: receipt.entityId }
        : {}),
    audit: {
      stream: "ops",
      category: "payment",
      action: "billing.payment_exception.open",
      summary: CAUSES[kind],
      target: { type: "payment_exception", id },
    },
    emit: {
      type: healed ? "payment_exception.auto_healed" : "payment_exception.opened",
      payload: healed
        ? { v: 1, paymentExceptionId: id }
        : {
            v: 1,
            paymentExceptionId: id,
            kind,
            billingOrderId: order?.id ?? null,
            paymentTxnId: receipt.id,
            amountFen,
          },
      dedupeKey: `${healed ? "payment_exception.auto_healed" : "payment_exception.opened"}:${id}`,
    },
  });
  if (order && !healed)
    await tx.billingOrder.update({
      where: { id: order.id },
      data: { hasOpenException: true, updatedAt: now },
    });
  await tx.paymentTxn.update({
    where: { id: receipt.id },
    data: { reconState: healed ? receipt.reconState : "diff", updatedAt: now },
  });
  return id;
}
