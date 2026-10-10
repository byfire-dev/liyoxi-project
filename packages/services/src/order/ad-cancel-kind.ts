import { CancelApproveBodySchema } from "@liyoxi/contract";
import type { AdCancelCoreSubmitBody } from "@liyoxi/contract";
import { defineApprovalKind } from "../approval/index.js";
import { assertConfirm } from "../authz/index.js";
import { chainKey, rowKey } from "../flow/index.js";
import type { Guard, MachineBinding } from "../flow/index.js";
import { AppError } from "../kernel/index.js";
import {
  approveAdCancelCallback,
  checkAdCancel,
  closeAdCancelCallback,
  validateAdCancelSubmission,
} from "./ad-cancel.js";
import { cancelCall, checkedCancel } from "./cancel-context.js";

export const adCancelKind = defineApprovalKind<AdCancelCoreSubmitBody>({
  category: "approval",
  domain: { table: "cancel_request", column: "approval_request_id" },
  viewModules: ["order", "finance"],
  decidePermission: "finance.refund.approve",
  groupBound: false,
  hasExecution: true,
  numberPrefix: "TK",
  operations: {
    get: "admin.cancelRequest.get",
    approve: "admin.cancelRequest.approve",
    reject: "admin.cancelRequest.reject",
    withdraw: "admin.cancelRequest.withdraw",
  },
  validate: async (tx, submission) => {
    if (submission.kind !== "ad_cancel" || submission.subjectType !== "ad")
      throw new AppError("VALIDATION_FAILED");
    await validateAdCancelSubmission(tx, submission.subjectId, submission.input);
    const ad = await tx.ad.findUniqueOrThrow({ where: { id: submission.subjectId } });
    if (ad.entityId !== submission.entityId || ad.storeId !== submission.storeId)
      throw new AppError("PRECONDITION_CHANGED");
  },
  summarize: async (tx) => {
    const c = cancelCall(tx);
    return {
      title: `广告取消 ${c.quote!.lines[0]!.label}`,
      points: c.quote!.totalRefundPoints,
      domain: { type: "cancel_request", id: c.requestId! },
    };
  },
  revalidate: async (tx, row, args) => {
    if (!cancelCall(tx).auto) {
      const body = CancelApproveBodySchema.parse(args);
      const r = await tx.cancelRequest.findUniqueOrThrow({ where: { approvalRequestId: row.id } });
      assertConfirm(body.confirm, {
        requestNo: row.requestNo!,
        totalRefundPoints: r.totalRefundPoints,
      });
    }
    await checkAdCancel(tx, row);
  },
  onApproved: approveAdCancelCallback,
  onRejected: (tx, row) => closeAdCancelCallback(tx, row, "rejected"),
  onWithdrawn: (tx, row) => closeAdCancelCallback(tx, row, "withdrawn"),
  executionSla: async (tx, row) => {
    const r = await tx.cancelRequest.findUnique({ where: { approvalRequestId: row.id } });
    if (!r) return null;
    if (
      r.kind !== "ad_cancel" ||
      r.adId !== row.subjectId ||
      r.entityId !== row.entityId ||
      r.storeId !== row.storeId
    )
      throw new AppError("PRECONDITION_CHANGED");
    return { status: r.status, dueAt: r.execDueAt, hasExecuted: r.executedAt !== null };
  },
});
const guard: Guard = (_tx, facts) => Promise.resolve(checkedCancel(facts.args));
export const cancelRequestChain = chainKey("cancel_request", "status");
export const cancelRequestBinding: MachineBinding = {
  companions: [
    "exec_due_at",
    "sla_snapshot",
    "executed_at",
    "closed_at",
    "close_reason",
    "close_note",
    "is_executed_by_system",
    "executed_by_staff_id",
    "exec_confirm_checks",
  ],
  guards: Object.fromEntries(
    [
      ["09:547", "cancel.submit"],
      ["09:548", "approval.approved"],
      ["09:549", "approval.rejected"],
      ["09:550", "approval.withdrawn"],
      ["09:551", "cancel.execute"],
      ["09:552", "cancel.void"],
      ["09:553", "cancel.auto_execute"],
    ].map(([ref, event]) => [rowKey(ref!, event!), guard]),
  ),
};
