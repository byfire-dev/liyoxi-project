import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import type { ApprovalReads } from "./read.js";

export async function approvalForNotify(tx: Tx, id: string) {
  const row = await tx.approvalRequest.findUnique({ where: { id } });
  return row
    ? {
        bizType: "approval_request",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.status,
        version: row.roundNo,
        name: "审批事项",
        staffIds: row.requesterStaffId ? [row.requesterStaffId] : [],
      }
    : null;
}

/** Uses the owning approval's one decision predicate, including self/group/scope guards. */
export async function approvalRecipientsForNotify(
  tx: Tx,
  id: string,
  reads: Pick<ApprovalReads, "decisionView">,
  contexts: readonly StaffContext[],
) {
  const ids: string[] = [];
  for (const context of contexts) {
    try {
      const item = await reads.decisionView(tx, context, id);
      if (item.actions.includes("approve") || item.actions.includes("approve-review"))
        ids.push(context.staff.id);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("error" in error) ||
        !["PERMISSION_DENIED", "NOT_FOUND"].includes(String(error.error))
      )
        throw error;
    }
  }
  return ids;
}

export async function pendingApprovalsForNotify(tx: Tx) {
  return tx.approvalRequest.findMany({
    where: { status: "pending" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
}
