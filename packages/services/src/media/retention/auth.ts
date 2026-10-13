import {
  authorize,
  buildStaffContext,
  isStaffRoleKey,
  normalizeRoleConfig,
} from "../../authz/index.js";
import type { PermissionKey } from "@liyoxi/contract/authz";
import { record } from "../../audit/index.js";
import type { AuditAction } from "@liyoxi/contract";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { RetentionActor, RetentionDeps } from "./types.js";
/** 重放前和业务锁后均读真实员工/会话/角色；GET不续写会话。 */
export async function currentStaff(
  deps: RetentionDeps,
  tx: Tx,
  actor: RetentionActor,
  permission: PermissionKey | null,
  locked = false,
  skipStepUp = false,
) {
  const now = deps.clock.now();
  if (
    actor.identity.actor.type !== "staff" ||
    actor.identity.actor.client !== "admin" ||
    actor.identity.actor.id !== actor.staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  if (locked) await lockRows(tx, "staff", [actor.staff.staff.id], "share");
  const session = actor.meta.sessionId
    ? await tx.staffSession.findUnique({ where: { id: actor.meta.sessionId } })
    : null;
  if (
    !session ||
    session.staffId !== actor.staff.staff.id ||
    session.revokedAt ||
    session.idleExpiresAt <= now ||
    session.absoluteExpiresAt <= now
  )
    throw new AppError("SESSION_INVALID");
  const staff = await tx.staff.findUnique({ where: { id: actor.staff.staff.id } });
  if (
    !staff ||
    staff.status !== "active" ||
    !isStaffRoleKey(staff.staffRoleKey) ||
    staff.staffRoleKey !== actor.staff.staff.roleKey ||
    staff.isLead !== actor.staff.staff.isLead ||
    staff.staffGroupId !== actor.staff.staff.staffGroupId
  )
    throw new AppError("PERMISSION_DENIED");
  const role = await tx.staffRole.findUniqueOrThrow({ where: { key: staff.staffRoleKey } });
  const group = staff.staffGroupId
    ? await tx.staff.findMany({
        where: { staffGroupId: staff.staffGroupId, status: "active" },
        select: { id: true },
      })
    : [staff];
  const fresh = buildStaffContext({
    staff: {
      id: staff.id,
      roleKey: staff.staffRoleKey,
      isLead: staff.isLead,
      staffGroupId: staff.staffGroupId,
    },
    role: normalizeRoleConfig(staff.staffRoleKey, role),
    groupStaffIds: group.map((s) => s.id),
    stepUpAt: session.stepupAt,
  });
  authorize(fresh, { module: { module: "system", need: "view" }, permission }, now, { skipStepUp });
  return fresh;
}
export async function audit(
  tx: Tx,
  actor: RetentionActor,
  action: AuditAction,
  id: string,
  reason?: string,
) {
  await record(tx, actor.identity.actor, actor.meta, {
    stream: "ops",
    category: "system_ops",
    action,
    summary:
      action === "files.file.restore"
        ? "恢复已清除文件"
        : action === "files.file.erase"
          ? "彻底删除文件"
          : action === "files.purge.approve"
            ? "放行文件清除运行"
            : "驳回文件清除运行",
    target: { type: action.startsWith("files.purge.") ? "file_purge_run" : "file_object", id },
    ...(reason ? { reason: { code: "other", text: reason } } : {}),
  });
}
