import { fulfillResultSchema } from "@liyoxi/contract";
import {
  AppError,
  createIdentityContext,
  isAppError,
  savepoint,
  uuidv7,
} from "../../../kernel/index.js";
import type { IdentityContext, Tx } from "../../../kernel/index.js";
import type { WechatPayRefund } from "../../../providers/types.js";
import { createTermRefund } from "../../subscription/index.js";
import { applyRefundCash } from "../../refund/result.js";
import type { LockedException, PaymentExceptionDeps } from "./context.js";
import { openFact } from "./facts.js";

/** 唯一入口位于C51查询的settle；客户端不能自行提交渠道退款事实。 */
export async function recordExternalRefund(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  state: LockedException,
  fact: WechatPayRefund,
) {
  const { exception, receipt, order } = state;
  const line = exception.wxBillLineId
    ? await tx.wxBillLine.findUnique({ where: { id: exception.wxBillLineId } })
    : null;
  if (
    !receipt ||
    receipt.channel !== "wechat_jsapi" ||
    receipt.status !== "succeeded" ||
    !line ||
    line.lineKind !== "refund" ||
    line.isForeign ||
    line.outTradeNo !== receipt.outTradeNo ||
    line.transactionId !== receipt.channelTxnNo ||
    line.outRefundNo !== fact.outRefundNo ||
    line.refundId !== fact.refundId ||
    fact.outTradeNo !== receipt.outTradeNo ||
    fact.status !== "SUCCESS" ||
    !fact.successAt ||
    !Number.isFinite(fact.successAt.getTime()) ||
    fact.successAt > deps.clock.now() ||
    fact.refundFen <= 0 ||
    fact.refundFen !== line.refundAmountFen ||
    line.orderAmountFen !== receipt.channelAmountFen ||
    line.appid !== deps.wechatPay?.appid ||
    line.mchid !== deps.wechatPay?.mchid
  )
    throw new AppError("CHANNEL_RECHECK_FAILED", {
      details: { channelState: fact.status, channelAmountFen: fact.refundFen },
    });
  const old = await tx.refundTxn.findUnique({ where: { outRefundNo: fact.outRefundNo } });
  // 现有本库退款不能冒充external再累计；新query重放只在同一真实来源完全一致时可复用。
  if (
    old &&
    (old.origin !== "external" ||
      old.paymentTxnId !== receipt.id ||
      old.status !== "succeeded" ||
      old.amountFen !== fact.refundFen ||
      old.channelRefundNo !== fact.refundId ||
      old.successAt?.getTime() !== fact.successAt.getTime())
  )
    throw new AppError("CHANNEL_RECHECK_FAILED");
  const now = deps.clock.now();
  const refund =
    old ??
    (await tx.refundTxn.create({
      data: {
        id: uuidv7(),
        entityId: receipt.entityId,
        billingOrderId: receipt.billingOrderId,
        paymentTxnId: receipt.id,
        refundRequestId: null,
        channel: "wechat_jsapi",
        origin: "external",
        outRefundNo: fact.outRefundNo,
        amountFen: fact.refundFen,
        status: "succeeded",
        channelRefundNo: fact.refundId,
        successAt: fact.successAt,
        reconState: "matched",
        createdAt: now,
        updatedAt: now,
      },
    }));
  const system = createIdentityContext({
    actor: { type: "system", job: "billing.external_refund" },
    ...(receipt.entityId ? { entityId: receipt.entityId } : {}),
  });
  const refunded = old
    ? receipt.refundedFen
    : await applyRefundCash(
        tx,
        deps,
        { receipt, order, request: { entityId: receipt.entityId } },
        refund,
      );
  await tx.paymentException.update({
    where: { id: exception.id },
    data: { refundTxnId: refund.id, updatedAt: now },
  });
  if (refunded > (receipt.channelAmountFen ?? 0))
    await openFact(tx, deps, ctx, {
      kind: "refund_over",
      dedupeKey: `refund_over:${fact.outRefundNo}`,
      entityId: receipt.entityId,
      billingOrderId: receipt.billingOrderId,
      paymentTxnId: receipt.id,
      refundTxnId: refund.id,
      amountFen: refunded - (receipt.channelAmountFen ?? 0),
      causeText: "真实渠道退款累计超过实收",
      detectedBy: "query",
      billFact: {
        refundId: fact.refundId,
        outRefundNo: fact.outRefundNo,
        amountFen: fact.refundFen,
        state: fact.status,
        occurredAt: fact.successAt.toISOString(),
      },
      platformFact: { amountFen: refunded },
    });
  // 仅已入账的原付款款项触发发票与权益处理，重复收款绝不改原单。
  if (order && receipt.appliedAt && order.paidPaymentTxnId === receipt.id) {
    for (const invoice of state.invoices.filter((i) => i.status === "issued"))
      await deps.flow.transition(tx, system, {
        machine: "invoice_request",
        stateField: "status",
        id: invoice.id,
        event: "invoice.request_red",
        ref: "08:1115",
        entityId: invoice.entityId,
        audit: {
          stream: "ops",
          category: "recon",
          action: "finance.payment_exception.request_red",
          summary: "补记真实外部退款后请求红冲",
          target: { type: "invoice_request", id: invoice.id },
        },
        emit: {
          type: "invoice.red_requested",
          payload: { v: 1, invoiceRequestId: invoice.id },
          dedupeKey: `invoice.red_requested:external:${refund.id}:${invoice.id}`,
        },
      });
    if (["plan_new", "plan_renew", "plan_upgrade"].includes(order.type)) {
      const result = fulfillResultSchema.safeParse(order.fulfillmentResult);
      const termId = result.success && result.data.status === "done" ? result.data.termId : null;
      let problem: {
        unrecoveredPoints: number;
        heldByRefundRequestId: string | null;
        reason?: string;
      };
      try {
        if (!termId) throw new AppError("PLAN_REFUND_NOT_ELIGIBLE");
        problem = await savepoint(tx, () =>
          createTermRefund({ clock: deps.clock, events: deps.events }).revokeTermForExternalRefund(
            tx,
            ctx,
            { termId, paymentExceptionId: exception.id },
          ),
        );
      } catch (error) {
        // 仅正式业务守卫可转入差异；DB/锁序/ACCOUNT_BUSY等必须整TX失败重试。
        if (!isAppError(error) || error.error !== "PLAN_REFUND_NOT_ELIGIBLE") throw error;
        problem = {
          unrecoveredPoints: 0,
          heldByRefundRequestId: null,
          reason: "term_not_recoverable",
        };
      }
      if (problem.unrecoveredPoints > 0 || problem.heldByRefundRequestId || problem.reason)
        await openFact(tx, deps, ctx, {
          kind: "entitlement_unrecovered",
          dedupeKey: `entitlement_unrecovered:${exception.id}`,
          entityId: receipt.entityId,
          billingOrderId: order.id,
          paymentTxnId: receipt.id,
          refundTxnId: refund.id,
          amountFen: fact.refundFen,
          detectedBy: "query",
          causeText: "渠道已退款，权益尚有未回收事实",
          platformFact: {
            text: problem.heldByRefundRequestId
              ? "refund_gate_held"
              : (problem.reason ?? "points_used"),
            unrecoveredPoints: problem.unrecoveredPoints,
          },
        });
    }
  }
  await tx.wxBillLine.update({
    where: { id: line.id },
    data: {
      matchedRefundTxnId: refund.id,
      matchedPaymentTxnId: receipt.id,
      matchState: "matched",
      updatedAt: now,
    },
  });
}
