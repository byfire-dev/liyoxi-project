// 指定员工的运维命令：真实 active 账号与当前角色，无会话/无伪造 step-up。
import type { Tx } from "../kernel/index.js";
import { AppError, isUuid } from "../kernel/index.js";
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import { lockStaff } from "./repo.js";
export async function loadCliStaffContext(tx: Tx, staffId: string) {
  if (!isUuid(staffId)) throw new AppError("VALIDATION_FAILED");
  const staff = await lockStaff(tx, staffId);
  if (!staff || staff.status !== "active") throw new AppError("PERMISSION_DENIED");
  await tx.$queryRawUnsafe("SELECT key FROM staff_role WHERE key=$1 FOR SHARE", staff.staffRoleKey);
  const role = await tx.staffRole.findUnique({ where: { key: staff.staffRoleKey } });
  if (!role || !isStaffRoleKey(role.key)) throw new AppError("PERMISSION_DENIED");
  const members =
    staff.staffGroupId === null
      ? []
      : await tx.staff.findMany({
          where: { staffGroupId: staff.staffGroupId },
          select: { id: true },
          orderBy: { id: "asc" },
        });
  return buildStaffContext({
    staff: {
      id: staff.id,
      roleKey: role.key,
      isLead: staff.isLead,
      staffGroupId: staff.staffGroupId,
    },
    role: normalizeRoleConfig(role.key, role),
    groupStaffIds: members.map((row) => row.id),
    stepUpAt: null,
  });
}
