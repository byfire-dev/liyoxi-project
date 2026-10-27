import { rejectInvoiceAfterRefund } from "../invoices/refund.js";
// 回调/查询/未来账单共用；只接受经过真实来源验证的归一事实。资金事实优先于旧技术状态。
import { calendarDate } from "@liyoxi/shared/time";
import { alertsOf, AppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { RefundTxn } from "@liyoxi/db";
import type { WechatPayRefund } from "../../providers/types.js";
import { lockRefund } from "./context.js";
import type { RefundDeps, LockedRefund } from "./context.js";
import { completed, failed, system } from "./state.js";

async function difference(
  tx: Tx,
  deps: RefundDeps,
  state: LockedRefund,
  txn: RefundTxn,
  fact: WechatPayRefund,
  kind: "refund_over" | "status_mismatch" | "refund_amount_mismatch",
  amountFen: number,
  detectedBy: "callback" | "query",
) {
  const key =
    kind === "status_mismatch"
      ? `status_mismatch:refund:${txn.outRefundNo}`
      : `${kind}:${txn.outRefundNo}`;
  if (await tx.paymentException.findUnique({ where: { dedupeKey: key } })) return;
  const now = deps.clock.now(),
    id = uuidv7();
  const inserted = await tx.paymentException.createMany({
    data: [
      {
        id,
        exceptionNo: await deps.bizNo.next(tx, "CY"),
        entityId: txn.entityId,
        billingOrderId: txn.billingOrderId,
        paymentTxnId: txn.paymentTxnId,
        refundTxnId: txn.id,
        kind,
        detectedBy,
        billDate: new Date(`${calendarDate(now)}T00:00:00.000Z`),
        amountFen,
        causeText: "退款渠道事实需财务核对",
        dedupeKey: key,
        status: "open",
        resolution: "none",
        billFact: {
          refundId: fact.refundId,
          amountFen: fact.refundFen,
          state: fact.status,
          occurredAt: fact.successAt?.toISOString() ?? null,
        },
        platformFact: { amountFen: txn.amountFen, state: txn.status },
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (!inserted.count) return;
  await alertsOf(deps.assembly).raise({
    rule: "billing.refund_stuck",
    dimension: txn.id,
    severity: "P1",
    detail: { kind, refundTxnId: txn.id, amountFen },
  });
  await deps.flow.transition(tx, system(state.request), {
    machine: "payment_exception",
    stateField: "status",
    id,
    event: "payment_exception.open",
    ref: "08:760",
    created: true,
    ...(txn.entityId ? { entityId: txn.entityId } : {}),
    audit: {
      stream: "ops",
      category: "refund",
      action: "finance.refund.exception",
      summary: "退款渠道事实需财务核对",
      target: { type: "payment_exception", id },
    },
    emit: {
      type: "payment_exception.opened",
      payload: {
        v: 1,
        paymentExceptionId: id,
        kind,
        billingOrderId: txn.billingOrderId,
        paymentTxnId: txn.paymentTxnId,
        amountFen,
      },
      dedupeKey: `payment_exception.opened:${id}`,
    },
  });
  if (txn.billingOrderId)
    await tx.billingOrder.update({
      where: { id: txn.billingOrderId },
      data: { hasOpenException: true, updatedAt: now },
    });
  await tx.paymentTxn.update({
    where: { id: txn.paymentTxnId },
    data: { reconState: "diff", updatedAt: now },
  });
}
/** 已持久成功的现金交易共用唯一累计入口；调用方保证首次成功，与完成动作同TX。 */
export async function applyRefundCash(
  tx: Tx,
  deps: RefundDeps,
  state: LockedRefund,
  txn: RefundTxn,
) {
  const now = deps.clock.now();
  const refunded = state.receipt.refundedFen + txn.amountFen;
  await tx.paymentTxn.update({
    where: { id: txn.paymentTxnId },
    data: { refundedFen: refunded, updatedAt: now },
  });
  // h01§3.2：请求金额保留；可信渠道金额不一致另存差异，累计仍按本退款交易金额。
  if (state.order && state.order.paidPaymentTxnId === txn.paymentTxnId && state.receipt.appliedAt) {
    const orderRefunded = state.order.refundedAmountFen + txn.amountFen;
    await tx.billingOrder.update({
      where: { id: state.order.id },
      data: { refundedAmountFen: orderRefunded, updatedAt: now },
    });
    if (state.order.status === "paid" && orderRefunded >= state.order.paidAmountFen) {
      await deps.flow.transition(tx, system(state.request), {
        machine: "billing_order",
        stateField: "status",
        id: state.order.id,
        event: "billing_order.refund",
        ref: "08:177",
        entityId: state.order.entityId,
        set: { refunded_at: now },
        audit: {
          stream: "ops",
          category: "refund",
          action: "billing.order.refunded",
          summary: "可信现金退款累计达到原实付",
          target: { type: "billing_order", id: state.order.id },
        },
        emit: {
          type: "billing_order.refunded",
          payload: {
            v: 1,
            billingOrderId: state.order.id,
            entityId: state.order.entityId,
            refundedFen: orderRefunded,
          },
          dedupeKey: `billing_order.refunded:${state.order.id}`,
        },
      });
      await rejectInvoiceAfterRefund(tx, deps, system(state.request), state.order.id);
    }
  }
  return refunded;
}

/** 调用者必须持有可信来源（WebhookSource验证或Provider查询）；HTTP请求体不能直接调用此公口。 */
export async function recordRefundResult(
  tx: Tx,
  deps: RefundDeps,
  _ctx: IdentityContext,
  input: { refundTxnId: string; fact: WechatPayRefund; detectedBy: "callback" | "query" },
) {
  const before = await tx.refundTxn.findUnique({ where: { id: input.refundTxnId } });
  if (!before?.refundRequestId) throw new AppError("NOT_FOUND");
  const state = await lockRefund(tx, before.refundRequestId),
    txn = state.txns.find((t) => t.id === before.id);
  if (!txn) throw new AppError("NOT_FOUND");
  const { fact } = input;
  if (
    txn.channel !== "wechat_jsapi" ||
    fact.outRefundNo !== txn.outRefundNo ||
    fact.outTradeNo !== state.receipt.outTradeNo ||
    !fact.refundId ||
    !Number.isSafeInteger(fact.refundFen) ||
    fact.refundFen <= 0
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  const existingNo = await tx.refundTxn.findFirst({
    where: { channel: "wechat_jsapi", channelRefundNo: fact.refundId, id: { not: txn.id } },
  });
  if (existingNo) throw new AppError("PROVIDER_UNAVAILABLE");
  if (txn.status === "succeeded") {
    if (txn.channelRefundNo !== fact.refundId) throw new AppError("PROVIDER_UNAVAILABLE");
    if (fact.refundFen !== txn.amountFen)
      await difference(
        tx,
        deps,
        state,
        txn,
        fact,
        "refund_amount_mismatch",
        Math.abs(fact.refundFen - txn.amountFen),
        input.detectedBy,
      );
    if (fact.status !== "SUCCESS")
      await alertsOf(deps.assembly).raise({
        rule: "billing.refund_stuck",
        dimension: txn.id,
        severity: "P1",
        detail: {
          problem: "contradictory_terminal",
          persistedStatus: txn.status,
          channelStatus: fact.status,
        },
      });
    return { replayed: true };
  }
  const now = deps.clock.now();
  if (fact.status !== "SUCCESS") {
    // 失败终态不能被旧processing回写；成功永远由下方分支接纳。
    if (!["created", "processing", "abnormal"].includes(txn.status)) return { replayed: true };
    const status =
      fact.status === "CLOSED"
        ? "closed"
        : fact.status === "ABNORMAL" || txn.status === "abnormal"
          ? "abnormal"
          : "processing";
    await tx.refundTxn.update({
      where: { id: txn.id },
      data: {
        status,
        channelRefundNo: fact.refundId,
        lastQueriedAt: input.detectedBy === "query" ? now : txn.lastQueriedAt,
        updatedAt: now,
      },
    });
    if (status === "abnormal")
      await alertsOf(deps.assembly).raise({
        rule: "billing.refund_stuck",
        dimension: txn.id,
        severity: "P2",
        detail: { refundTxnId: txn.id, status },
      });
    if (status === "closed") {
      await failed(tx, deps, state, txn.id, "closed");
      await deps.timers.cancel(tx, {
        subject: { type: "refund_txn", id: txn.id },
        kinds: ["rf.poll"],
      });
    }
    return { replayed: false };
  }
  if (!fact.successAt || !Number.isFinite(fact.successAt.getTime()) || fact.successAt > now)
    throw new AppError("PROVIDER_UNAVAILABLE");
  const late = ["closed", "not_accepted", "abandoned"].includes(txn.status);
  await tx.refundTxn.update({
    where: { id: txn.id },
    data: {
      status: "succeeded",
      channelRefundNo: fact.refundId,
      successAt: fact.successAt,
      userReceivedAccount: fact.userReceivedAccount ?? null,
      isLateSuccess: late,
      failCode: null,
      failMessage: null,
      updatedAt: now,
    },
  });
  const refunded = await applyRefundCash(tx, deps, state, txn);
  if (refunded > (state.receipt.channelAmountFen ?? 0))
    await difference(
      tx,
      deps,
      state,
      txn,
      fact,
      "refund_over",
      refunded - (state.receipt.channelAmountFen ?? 0),
      input.detectedBy,
    );
  else if (late)
    await difference(
      tx,
      deps,
      state,
      txn,
      fact,
      "status_mismatch",
      txn.amountFen,
      input.detectedBy,
    );
  if (fact.refundFen !== txn.amountFen)
    await difference(
      tx,
      deps,
      state,
      txn,
      fact,
      "refund_amount_mismatch",
      Math.abs(fact.refundFen - txn.amountFen),
      input.detectedBy,
    );
  await completed(tx, deps, state);
  await deps.timers.cancel(tx, { subject: { type: "refund_txn", id: txn.id }, kinds: ["rf.poll"] });
  await deps.onRefundStep?.("success");
  return { replayed: false };
}
