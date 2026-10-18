import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";

/** 本人注销清历史称呼；callerTx已移除当前成员时必须提前锁完整历史成员全集。 */
export async function clearAccountMemberNamesIn(tx: Tx, ctx: IdentityContext, now: Date) {
  if (ctx.actor.type !== "merchant" || ctx.actor.client !== "weapp")
    throw new AppError("ROLE_FORBIDDEN");
  const userId = ctx.actor.id;
  await lockRows(tx, "merchant_user", [userId]);
  const user = await tx.merchantUser.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (user?.status !== "active") throw new AppError("STATE_NOT_ALLOWED");
  const members = await tx.entityMember.findMany({
    where: { merchantUserId: userId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  await lockRows(
    tx,
    "entity_member",
    members.map((row) => row.id),
  );
  if (await tx.entityMember.count({ where: { merchantUserId: userId, status: "active" } }))
    throw new AppError("STATE_NOT_ALLOWED");
  await tx.entityMember.updateMany({
    where: { merchantUserId: userId, displayName: { not: null } },
    data: { displayName: null, updatedAt: now },
  });
}
