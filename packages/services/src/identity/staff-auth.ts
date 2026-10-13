import type { AuditRequestMeta } from "../audit/index.js";
import {
  authorize,
  buildStaffContext,
  isStaffRoleKey,
  normalizeRoleConfig,
} from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";

/** 账号安全后台路径共享的只读身份复核；不续写会话，不使用角色/本组缓存。 */
export async function currentIdentityStaff(
  tx: Tx,
  clock: Clock,
  ctx: IdentityContext,
  staff: StaffContext,
  meta: AuditRequestMeta,
): Promise<StaffContext> {
  const now = clock.now();
  if (ctx.actor.type !== "staff" || ctx.actor.client !== "admin" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  if (!meta.sessionId) throw new AppError("INTERNAL");
  const session = await tx.staffSession.findUnique({ where: { id: meta.sessionId } });
  if (
    !session ||
    session.staffId !== staff.staff.id ||
    session.revokedAt ||
    session.idleExpiresAt <= now ||
    session.absoluteExpiresAt <= now
  )
    throw new AppError("SESSION_INVALID");
  const row = await tx.staff.findUnique({ where: { id: staff.staff.id } });
  if (
    !row ||
    row.status !== "active" ||
    !isStaffRoleKey(row.staffRoleKey) ||
    row.staffRoleKey !== staff.staff.roleKey ||
    row.staffGroupId !== staff.staff.staffGroupId ||
    row.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
  const role = await tx.staffRole.findUniqueOrThrow({ where: { key: row.staffRoleKey } });
  const groupStaffIds = row.staffGroupId
    ? (
        await tx.staff.findMany({
          where: { staffGroupId: row.staffGroupId, status: "active" },
          select: { id: true },
        })
      ).map((member) => member.id)
    : [row.id];
  const fresh = buildStaffContext({
    staff: {
      id: row.id,
      roleKey: row.staffRoleKey,
      staffGroupId: row.staffGroupId,
      isLead: row.isLead,
    },
    role: normalizeRoleConfig(row.staffRoleKey, role),
    groupStaffIds,
    stepUpAt: session.stepupAt,
  });
  authorize(fresh, { module: { module: "merchant", need: "view" }, permission: null }, now);
  return fresh;
}
