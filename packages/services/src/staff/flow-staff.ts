import type { Tx } from "../kernel/index.js";

/** Caller (flow) owns staff20 SHARE; this read always uses that transaction. */
export async function readAdminFlowStaff(tx: Tx, id: string) {
  const row = await tx.staff.findUnique({
    where: { id },
    select: { id: true, status: true, staffRoleKey: true, staffGroupId: true, isLead: true },
  });
  return row
    ? {
        id: row.id,
        status: row.status,
        roleKey: row.staffRoleKey,
        staffGroupId: row.staffGroupId,
        isLead: row.isLead,
      }
    : null;
}
