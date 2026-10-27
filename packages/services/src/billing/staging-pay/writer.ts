import { RefundBreakdownSchema } from "@liyoxi/contract";
import { AppError, createIdempotencyContext, lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { approvalOf, lockRefund, termsOf } from "../refund/context.js";
import type { RefundDeps } from "../refund/context.js";
import { quoteSystemWindow } from "../refund/quote.js";
import { createRefundSaga } from "../refund/saga.js";
import { transition } from "../refund/state.js";
import { assertStagingRefund, stagingOrder, STAGING_REFUND_KIND } from "./guards.js";
import type { StagingRefundSubmission } from "./kind.js";

/** 真实系统提交；与人工链共用窗口报价、周期闸门及退款状态机，不虚构客服原因。 */
async function submit(tx: Tx, deps: RefundDeps, ctx: IdentityContext, orderId: string) {
  const first = await stagingOrder(tx, deps, ctx, orderId);
  // 永久领域事实先于短期幂等缓存：已处理/关闭的单也不能新起退款申请。
  const previous = await tx.refundRequest.findFirst({
    where: { billingOrderId: orderId, source: "staging_probe" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (previous) {
    await assertStagingRefund(tx, deps, ctx, await lockRefund(tx, previous.id));
    return previous.id;
  }
  const id = uuidv7();
  const approval = await approvalOf(deps).submit(tx, ctx, {
    kind: STAGING_REFUND_KIND,
    subjectType: "billing_order",
    subjectId: orderId,
    entityId: first.order.entityId,
    input: { ctx, requestId: id } satisfies StagingRefundSubmission,
  });
  await lockRows(tx, "billing_order", [orderId]);
  await lockRows(tx, "payment_txn", [first.receipt.id]);
  const invoices = await tx.invoiceRequest.findMany({
    where: { billingOrderId: orderId },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "invoice_request",
    invoices.map((i) => i.id),
  );
  await deps.ledger.lockAccount(tx, first.order.entityId);
  const { order, receipt } = await stagingOrder(tx, deps, ctx, orderId);
  if (receipt.id !== first.receipt.id || receipt.refundedFen !== 0)
    throw new AppError("PRECONDITION_CHANGED");
  const calculated = await quoteSystemWindow(tx, deps, order);
  if (
    !calculated.supported ||
    !calculated.rules.find((r) => r.rule === "window")?.eligible ||
    !calculated.term ||
    calculated.refundableFen !== order.amountFen ||
    calculated.routePreview !== "wechat_original"
  )
    throw new AppError("PLAN_REFUND_NOT_ELIGIBLE");
  if (calculated.invoice.needsRedInvoice) throw new AppError("RED_INVOICE_REQUIRED");
  const facts = await termsOf(deps).previewPlanRefund(tx, calculated.term.subscriptionTermId);
  const now = deps.clock.now();
  const request = await tx.refundRequest.create({
    data: {
      id,
      approvalRequestId: approval.approvalId,
      source: "staging_probe",
      entityId: order.entityId,
      billingOrderId: order.id,
      paymentTxnId: receipt.id,
      baseAmountFen: calculated.refundableFen,
      amountFen: calculated.refundableFen,
      ruleCode: "window",
      ruleText: "开通或续费7天内且未使用积分（含冻结），全额退款",
      reasonCode: null,
      isOverride: false,
      status: "pending_approval",
      breakdownSnapshot: RefundBreakdownSchema.parse({
        v: 1,
        rule: "window",
        ...facts,
        refundableFen: calculated.refundableFen,
      }),
      createdAt: now,
      updatedAt: now,
    },
  });
  await termsOf(deps).suspendTermForRefund(tx, ctx, {
    termId: facts.termId,
    refundRequestId: id,
    requestNo: approval.requestNo!,
    rule: "window",
  });
  for (const invoice of invoices)
    if (invoice.status === "pending")
      await tx.invoiceRequest.update({
        where: { id: invoice.id },
        data: { heldByRefundRequestId: id, updatedAt: now },
      });
  await transition(tx, deps, ctx, request, {
    event: "refund.submit",
    ref: "08:523",
    action: "submitted",
    created: true,
    payload: { approvalRequestId: approval.approvalId, ruleCode: "window" },
  });
  return id;
}

/** 仅领域专口，尚不登记job/HTTP；每个阶段真实system留痕，外呼仍由同一Saga执行。 */
export function createStagingRefunds(deps: RefundDeps) {
  const saga = createRefundSaga(deps);
  return {
    async refundOrder(ctx: IdentityContext, orderId: string) {
      // 缓存重放也先验当前配置和真实付款事实，不能借旧键恢复被撤掉的授权。
      await deps.tx.run((tx) => stagingOrder(tx, deps, ctx, orderId));
      const options = (step: string) => ({
        idem: createIdempotencyContext({
          mode: "required",
          scope: `stg.pay.autorefund.${step}`,
          actor: ctx.actor,
          key: `${orderId}:${step}`,
          request: { method: "POST", body: { orderId } },
        }),
      });
      const id = await deps.tx.run((tx) => submit(tx, deps, ctx, orderId), options("submit"));
      // 账户为提交事务最后一把锁；系统决定另开事务，保持审批→领域→账户的锁序。
      await deps.tx.run(async (tx) => {
        const state = await lockRefund(tx, id);
        await assertStagingRefund(tx, deps, ctx, state);
        if (state.request.status === "pending_approval")
          await approvalOf(deps).approve(tx, ctx, {
            approvalId: state.approval.id,
          });
      }, options("approve"));
      const request = await deps.tx.run(async (tx) => {
        const state = await lockRefund(tx, id);
        await assertStagingRefund(tx, deps, ctx, state);
        return state.request;
      });
      if (!["pending_execution", "executing"].includes(request.status))
        return { refundRequestId: id, status: request.status };
      return saga.executeSystem(ctx, id, options("execute"));
    },
  };
}
