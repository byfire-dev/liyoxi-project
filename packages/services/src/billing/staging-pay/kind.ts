import { defineApprovalKind } from "../../approval/index.js";
import { AppError } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import { refundApproval } from "../refund/approval.js";
import { lockRefund } from "../refund/context.js";
import type { RefundDeps } from "../refund/context.js";
import { system } from "../refund/state.js";
import {
  assertStagingRefund,
  stagingOrder,
  STAGING_REFUND_JOB,
  STAGING_REFUND_KIND,
} from "./guards.js";

export interface StagingRefundSubmission {
  readonly ctx: IdentityContext;
  readonly requestId: string;
}
/** 复用原退款审批生命周期；本kind只供后继stg登记，不添加HTTP操作入口。 */
export function stagingRefundApproval(current: () => RefundDeps) {
  const original = refundApproval(current);
  return defineApprovalKind<StagingRefundSubmission>({
    ...original,
    operations: { get: "admin.refundRequest.get", approve: null, reject: null, withdraw: null },
    validate: async (tx, submission) => {
      if (
        submission.kind !== STAGING_REFUND_KIND ||
        submission.subjectType !== "billing_order" ||
        !submission.entityId ||
        submission.input.ctx.entityId !== submission.entityId
      )
        throw new AppError("PERMISSION_DENIED");
      const { order } = await stagingOrder(
        tx,
        current(),
        submission.input.ctx,
        submission.subjectId,
      );
      if (order.entityId !== submission.entityId || submission.storeId !== null)
        throw new AppError("PRECONDITION_CHANGED");
    },
    summarize: async (tx, submission) => {
      const { order } = await stagingOrder(
        tx,
        current(),
        submission.input.ctx,
        submission.subjectId,
      );
      return {
        title: "预发小额验证系统退款",
        amountFen: order.amountFen,
        domain: { type: "refund_request", id: submission.input.requestId },
      };
    },
    revalidate: async (tx, row, args) => {
      const request = await tx.refundRequest.findUniqueOrThrow({
        where: { approvalRequestId: row.id },
      });
      const state = await lockRefund(tx, request.id);
      await assertStagingRefund(tx, current(), system(request, STAGING_REFUND_JOB), state);
      await original.revalidate(tx, row, args);
    },
    onApproved: async (tx, row, decision) => {
      if (!decision.isDecidedBySystem || decision.decidedByStaffId !== null)
        throw new AppError("PERMISSION_DENIED");
      await original.onApproved(tx, row, decision);
    },
    onRejected: async (tx, row, decision) => {
      if (!decision.isDecidedBySystem || decision.decidedByStaffId !== null)
        throw new AppError("PERMISSION_DENIED");
      await original.onRejected(tx, row, decision);
    },
    onWithdrawn: async (tx, row, decision) => {
      if (!decision.isDecidedBySystem || decision.decidedByStaffId !== null)
        throw new AppError("PERMISSION_DENIED");
      await original.onWithdrawn(tx, row, decision);
    },
  });
}

export const unboundStagingRefundApproval = stagingRefundApproval(() => {
  throw new TypeError("预发退款运行时未绑定或已关闭");
});
