import type { Tx } from "../kernel/index.js";

/** Stable intent identity; editing staff.updatedAt never creates a fresh invitation. */
export async function latestStaffWecomInviteKey(tx: Tx, staffId: string): Promise<string | null> {
  const row = await tx.auditLog.findFirst({
    where: {
      stream: "ops",
      targetType: "staff",
      targetId: staffId,
      action: "sys.staff.wecom_invite",
    },
    orderBy: { seq: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}
