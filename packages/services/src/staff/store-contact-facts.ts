import type { Tx } from "../kernel/index.js";

/** 实际当前接收人的未结联系义务；转移、作废和已联系的历史不冒充待办。 */
export async function readStoreManagerContact(
  tx: Tx,
  input: { storeId: string; managerId: string; now: Date },
) {
  const row = await tx.assignmentHistory.findFirst({
    where: {
      source: "store_manager",
      subjectType: "store",
      subjectId: input.storeId,
      toStaffId: input.managerId,
      contactDueAt: { not: null },
      contactedAt: null,
      contactVoidedAt: null,
    },
    orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
    select: { id: true, contactDueAt: true },
  });
  return row?.contactDueAt
    ? {
        assignmentHistoryId: row.id,
        contactDueAt: row.contactDueAt.toISOString(),
        isOverdue: row.contactDueAt < input.now,
      }
    : null;
}
