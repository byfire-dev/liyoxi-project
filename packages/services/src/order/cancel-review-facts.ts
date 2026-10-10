import { ApprovalSummarySchema } from "@liyoxi/contract";
import type { CancelReviewCause } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** Read the actual cancellation owner rows, including uncommitted rows in the caller's Tx. */
export async function readCancelReviewCause(
  tx: Tx,
  approvalRequestId: string,
): Promise<CancelReviewCause> {
  const r = await tx.cancelRequest.findUnique({
    where: { approvalRequestId },
    include: { approvalRequest: true, cancelRequestLines: { orderBy: { id: "asc" } } },
  });
  if (!r) throw new AppError("STATE_NOT_ALLOWED");
  const a = r.approvalRequest,
    lines = r.cancelRequestLines;
  const domain = ApprovalSummarySchema.parse(a.summarySnapshot).domain;
  if (
    !["order_cancel", "qualification_cancel"].includes(r.kind) ||
    a.kind !== r.kind ||
    a.category !== "approval" ||
    r.closedAt !== null ||
    a.entityId !== r.entityId ||
    a.storeId !== r.storeId ||
    domain?.type !== "cancel_request" ||
    domain.id !== r.id ||
    a.subjectType !== (r.kind === "order_cancel" ? "drama_order" : "store") ||
    a.subjectId !== (r.kind === "order_cancel" ? r.dramaOrderId : r.storeId) ||
    !(
      (a.status === "pending" && r.status === "pending_approval") ||
      (a.status === "approved" && r.status === "pending_execution")
    ) ||
    a.submitActorType !== (r.kind === "order_cancel" ? "staff" : "system") ||
    lines.length !== r.lineCount ||
    lines.length === 0 ||
    lines.some((l) => l.entityId !== r.entityId || l.storeId !== r.storeId)
  )
    throw new AppError("STATE_NOT_ALLOWED", { message: "取消申请与实际审批或明细不一致" });
  const orderItemIds = lines
    .filter((l) => l.targetType === "order_item")
    .map((l) => l.targetId)
    .sort();
  const items = await tx.orderItem.findMany({ where: { id: { in: orderItemIds } } });
  if (
    items.length !== orderItemIds.length ||
    items.some(
      (i) =>
        i.entityId !== r.entityId ||
        i.storeId !== r.storeId ||
        (r.kind === "order_cancel" && i.dramaOrderId !== r.dramaOrderId),
    ) ||
    (r.kind === "order_cancel" && orderItemIds.length !== lines.length)
  )
    throw new AppError("STATE_NOT_ALLOWED", { message: "取消明细的订单项归属不一致" });
  return {
    requestId: r.id,
    approvalRequestId,
    lineIds: lines.map((l) => l.id),
    lines: lines.map(({ id, targetType, targetId }) => ({ id, targetType, targetId })),
    entityId: r.entityId,
    storeId: r.storeId,
    orderItemIds,
    orderItems: items
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, dramaId, dramaOrderId }) => ({ id, dramaId, dramaOrderId })),
    approvalStatus: a.status as "pending" | "approved",
    submitActorType: a.submitActorType as "staff" | "system",
    submitActorId: a.submitActorId,
    submitClient: a.submitClient,
  };
}
