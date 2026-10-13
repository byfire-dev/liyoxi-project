import {
  authorize,
  buildStaffContext,
  isStaffRoleKey,
  normalizeRoleConfig,
} from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** 调用方已持staff20锁：等待期间的角色/组/权限变化必须立即反映到本次决定。 */
export async function currentReviewStaff(tx: Tx, previous: StaffContext, now: Date) {
  const row = await tx.staff.findUnique({ where: { id: previous.staff.id } });
  if (!row || row.status !== "active" || !isStaffRoleKey(row.staffRoleKey))
    throw new AppError("PERMISSION_DENIED");
  const role = await tx.staffRole.findUniqueOrThrow({ where: { key: row.staffRoleKey } });
  const group = row.staffGroupId
    ? await tx.staff.findMany({
        where: { staffGroupId: row.staffGroupId, status: "active" },
        select: { id: true },
      })
    : [];
  const current = buildStaffContext({
    staff: {
      id: row.id,
      roleKey: row.staffRoleKey,
      isLead: row.isLead,
      staffGroupId: row.staffGroupId,
    },
    role: normalizeRoleConfig(row.staffRoleKey, role),
    groupStaffIds: group.map((s) => s.id),
    stepUpAt: previous.stepUpAt,
  });
  authorize(current, { module: { module: "merchant", need: "view" }, permission: null }, now);
  return current;
}
