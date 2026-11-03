import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";
import type { SessionPrincipal } from "./types.js";
import { assertCurrentSession } from "./current-session.js";

export interface PortalOwnerRequest {
  readonly ctx: IdentityContext;
  readonly principal: SessionPrincipal;
}

/** 写操作依全局锁序冻结账号/主体/老板/门店；读操作只读，均不信任请求上的角色快照。 */
export async function assertPortalOwner(
  tx: Tx,
  request: PortalOwnerRequest,
  clock: Clock,
  appid: string,
  write = false,
) {
  const { ctx, principal } = request;
  if (
    ctx.actor.type !== "merchant" ||
    ctx.actor.client !== "weapp" ||
    principal.merchantUserId !== ctx.actor.id ||
    !ctx.entityId ||
    !ctx.storeId
  )
    throw new AppError("ROLE_FORBIDDEN");
  if (write) {
    await lockRows(tx, "merchant_user", [ctx.actor.id], "share");
    await lockRows(tx, "entity", [ctx.entityId], "share");
    const member = await tx.entityMember.findFirst({
      where: { entityId: ctx.entityId, merchantUserId: ctx.actor.id, status: "active" },
    });
    if (!member) throw new AppError("NOT_A_MEMBER");
    await lockRows(tx, "entity_member", [member.id], "share");
    await lockRows(tx, "store", [ctx.storeId], "share");
  }
  await assertCurrentSession(tx, principal, clock.now(), appid);
  const member = await tx.entityMember.findFirst({
    where: { entityId: ctx.entityId, merchantUserId: ctx.actor.id, status: "active" },
  });
  if (!member) throw new AppError("NOT_A_MEMBER");
  if (member.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
  const store = await tx.store.findFirst({
    where: { id: ctx.storeId, entityId: ctx.entityId, entity: { lifecycle: "active" } },
    select: { id: true, entityId: true, name: true },
  });
  if (!store) throw new AppError("NOT_FOUND");
  return {
    merchantUserId: ctx.actor.id,
    storeId: store.id,
    entityId: store.entityId,
    storeName: store.name,
  };
}
