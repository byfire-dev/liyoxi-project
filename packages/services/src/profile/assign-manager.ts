import { scopeCovers, storeScope } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { ProfileDeps } from "./context.js";
import { deliveryManagerPort, orderManagerPort } from "./ports.js";

/** 同事务首次指派；系统显式调用不套员工集合，员工入口必须传本请求的 DataScope。 */
export async function assignDeliveryManager(
  tx: Tx,
  deps: ProfileDeps,
  ctx: IdentityContext,
  input: { storeId: string; staffId: string; scope?: DataScope },
) {
  if (ctx.actor.type !== "system" && !input.scope) throw new AppError("PERMISSION_DENIED");
  const visible = await tx.store.findFirst({
    where: { id: input.storeId, ...(input.scope ? storeScope(input.scope) : {}) },
  });
  if (!visible) throw new AppError("NOT_FOUND");
  await lockRows(tx, "staff", [input.staffId], "share");
  const staff = await tx.staff.findUnique({ where: { id: input.staffId } });
  const refuse = (reason: string): never => {
    throw new AppError("ASSIGNEE_INVALID", { details: { staffId: input.staffId, reason } });
  };
  if (!staff || staff.status !== "active") return refuse("not_active");
  if (staff.staffRoleKey !== "delivery_manager") refuse("role_mismatch");
  if (input.scope && !scopeCovers(input.scope, input.staffId)) refuse("out_of_scope");
  await lockRows(tx, "store", [input.storeId]);
  const store = await tx.store.findUniqueOrThrow({ where: { id: input.storeId } });
  if (store.deliveryManagerId) throw new AppError("STORE_MANAGER_ASSIGNED");
  if (store.lifecycle !== "active") throw new AppError("PRECONDITION_CHANGED");
  await deps.tenant.setDeliveryManager(tx, ctx, input);
  const assignment = { ...input, entityId: store.entityId, ctx };
  await deps.assembly.port(orderManagerPort)(tx, assignment);
  await deps.assembly.port(deliveryManagerPort)(tx, assignment);
  return { storeId: store.id, staffId: staff.id, assignedAt: deps.clock.now().toISOString() };
}
