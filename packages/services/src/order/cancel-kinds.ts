import type { OrderCancelRequestCreateBody } from "@liyoxi/contract";
import { defineApprovalKind } from "../approval/index.js";
import type { ApprovalRow } from "../approval/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { approveAdCancelCallback } from "./ad-cancel.js";
import { cancelCall } from "./cancel-context.js";
import {
  checkOrderCancel,
  closeOrderCancelCallback,
  isOrderSubjectInvalidForWithdrawal,
} from "./cancel-decisions.js";
import {
  validateOrderCancelSubmission,
  validateQualificationCancelSubmission,
} from "./cancel-submit.js";
import type { QualificationCancelSubmission } from "./cancel-submit.js";

const base = {
  category: "approval" as const,
  domain: { table: "cancel_request", column: "approval_request_id" },
  viewModules: ["order", "finance"] as const,
  decidePermission: "finance.refund.approve" as const,
  groupBound: false,
  hasExecution: true,
  numberPrefix: "TK" as const,
  operations: {
    get: "admin.cancelRequest.get",
    approve: "admin.cancelRequest.approve",
    reject: "admin.cancelRequest.reject",
    withdraw: "admin.cancelRequest.withdraw",
  },
  revalidate: checkOrderCancel,
  onApproved: approveAdCancelCallback,
  onRejected: (tx: Tx, row: ApprovalRow) => closeOrderCancelCallback(tx, row, "rejected"),
  onWithdrawn: (tx: Tx, row: ApprovalRow) => closeOrderCancelCallback(tx, row, "withdrawn"),
  isSubjectInvalidForWithdrawal: isOrderSubjectInvalidForWithdrawal,
  executionSla: async (tx: Tx, row: ApprovalRow) => {
    const r = await tx.cancelRequest.findUnique({ where: { approvalRequestId: row.id } });
    if (!r) return null;
    if (
      r.kind !== row.kind ||
      r.entityId !== row.entityId ||
      r.storeId !== row.storeId ||
      row.subjectType !== (r.kind === "order_cancel" ? "drama_order" : "store") ||
      row.subjectId !== (r.kind === "order_cancel" ? r.dramaOrderId : r.storeId)
    )
      throw new AppError("PRECONDITION_CHANGED");
    return { status: r.status, dueAt: r.execDueAt, hasExecuted: r.executedAt !== null };
  },
};
export const orderCancelKind = defineApprovalKind<OrderCancelRequestCreateBody>({
  ...base,
  validate: async (tx, s) => {
    if (s.kind !== "order_cancel" || s.subjectType !== "drama_order")
      throw new AppError("VALIDATION_FAILED");
    await validateOrderCancelSubmission(tx, s.subjectId, s.input, s.approvalId);
    const order = await tx.dramaOrder.findUniqueOrThrow({ where: { id: s.subjectId } });
    if (order.entityId !== s.entityId || order.storeId !== s.storeId)
      throw new AppError("PRECONDITION_CHANGED");
  },
  summarize: async (tx, s) => {
    const c = cancelCall(tx),
      order = await tx.dramaOrder.findUniqueOrThrow({ where: { id: s.subjectId } });
    return {
      title: `订购取消 ${order.orderNo} · ${c.quote!.lines.length} 部`,
      points: c.quote!.totalRefundPoints,
      domain: { type: "cancel_request", id: c.requestId! },
    };
  },
});
export const qualificationCancelKind = defineApprovalKind<QualificationCancelSubmission>({
  ...base,
  validate: async (tx, s) => {
    if (
      s.kind !== "qualification_cancel" ||
      s.subjectType !== "store" ||
      s.subjectId !== s.input.storeId ||
      s.entityId !== s.input.entityId ||
      s.storeId !== s.input.storeId
    )
      throw new AppError("VALIDATION_FAILED");
    await validateQualificationCancelSubmission(tx, s.input, s.approvalId);
  },
  summarize: async (tx, s) => {
    const c = cancelCall(tx),
      store = await tx.store.findUniqueOrThrow({ where: { id: s.storeId! } });
    return {
      title: `资质终局整店取消 ${store.name ?? "门店"}`,
      points: c.quote!.totalRefundPoints,
      domain: { type: "cancel_request", id: c.requestId! },
    };
  },
});
