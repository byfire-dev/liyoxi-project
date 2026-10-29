import { assertPermission } from "../authz/index.js";
import type { PermissionKey } from "@liyoxi/contract/authz";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";

export function cancelStaff(actor: CancelActor) {
  if (
    actor.ctx.actor.type !== "staff" ||
    actor.ctx.actor.client !== "admin" ||
    !actor.staff ||
    actor.ctx.actor.id !== actor.staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  return actor.staff;
}
/** Current facts are checked before C50 replay as well as under the transaction's staff lock. */
export async function checkCancelStaff(tx: Tx, actor: CancelActor, locked = false) {
  const staff = cancelStaff(actor);
  if (locked) await lockRows(tx, "staff", [staff.staff.id], "share");
  const current = await tx.staff.findUnique({ where: { id: staff.staff.id } });
  if (
    !current ||
    current.status !== "active" ||
    current.staffRoleKey !== staff.staff.roleKey ||
    current.staffGroupId !== staff.staff.staffGroupId ||
    current.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
  return staff;
}
export function requireCancelPermission(
  deps: CancelDeps,
  actor: CancelActor,
  permission: PermissionKey,
  skipStepUp = false,
) {
  const staff = cancelStaff(actor);
  assertPermission(staff, permission, deps.clock.now(), { skipStepUp });
  return staff;
}
