import { scopeCovers, storeScope } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, Tx } from "../kernel/index.js";
import type { Tenant } from "../tenant/index.js";
import { deliveryManagerPort, orderManagerPort } from "./ports.js";

/** 同事务首次指派的最小装配；调用方不需要完整建档用例或外部服务。 */
export interface AssignDeliveryManagerDeps {
  readonly assembly: Pick<Assembly, "port">;
  readonly clock: Clock;
  readonly tenant: Pick<Tenant, "setDeliveryManager">;
}

/** 同事务首次指派；系统显式调用不套员工集合，员工入口必须传本请求的 DataScope。 */
export async function assignDeliveryManager(
  tx: Tx,
  deps: AssignDeliveryManagerDeps,
  ctx: IdentityContext,
  input: {
    storeId: string;
    staffId: string;
    scope?: DataScope;
    allowArchived?: boolean;
    note?: string;
  },
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
  if (store.deliveryManagerId)
    throw new AppError("STORE_MANAGER_ASSIGNED", {
      details: { deliveryManagerId: store.deliveryManagerId },
    });
  if (store.lifecycle !== "active" && !(input.allowArchived && store.lifecycle === "archived"))
    throw new AppError("PRECONDITION_CHANGED");
  const assignment = { ...input, entityId: store.entityId, ctx };
  const dramaOrderCount = (await deps.assembly.port(orderManagerPort)(tx, assignment)) ?? 0;
  const deliveryTicketCount = (await deps.assembly.port(deliveryManagerPort)(tx, assignment)) ?? 0;
  const synced = { dramaOrderCount, deliveryTicketCount };
  await deps.tenant.setDeliveryManager(tx, ctx, {
    ...input,
    auditMeta: { synced },
    note: input.note,
  });
  return {
    synced,
    storeId: store.id,
    staffId: staff.id,
    assignedAt: deps.clock.now().toISOString(),
  };
}
