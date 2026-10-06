import { scopeCovers } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { ManagerAssignment } from "../profile/index.js";
import type { DeliveryCoreDeps, DeliveryDeps } from "./context.js";
import { checked } from "./machines.js";
import { lockTickets, ticketOf } from "./repo.js";
import { orderSidePort } from "./ports.js";
const assignmentTargets = new WeakMap<Tx, { id: string; staff: StaffContext }>();
export async function assignStoreTickets(
  tx: Tx,
  deps: DeliveryCoreDeps,
  input: ManagerAssignment & { note?: string },
) {
  const rows = await tx.deliveryTicket.findMany({
    where: {
      storeId: input.storeId,
      entityId: input.entityId,
      OR: [
        { step: "assigning", pauseCount: 0 },
        ...(assignmentTargets.get(tx) ? [{ id: assignmentTargets.get(tx)!.id }] : []),
      ],
    },
    orderBy: { id: "asc" },
  });
  await lockTickets(
    tx,
    rows.map((r) => r.id),
  );
  const target = assignmentTargets.get(tx);
  if (target) {
    const current = await ticketOf(tx, target.id, target.staff);
    if (current.step !== "assigning") throw new AppError("STATE_NOT_ALLOWED");
    if (current.pauseCount > 0)
      throw new AppError("TICKET_ON_HOLD", {
        details: { reasons: current.deliveryTicketPauses.map((r) => r.reason) },
      });
  }
  let count = 0;
  for (const r of rows) {
    const fresh = await ticketOf(tx, r.id);
    if (fresh.step !== "assigning" || fresh.pauseCount > 0) continue;
    await assignOne(tx, deps, input.ctx, r.id, input.staffId, input.note);
    count++;
  }
  if (count)
    await deps.assembly
      .port(orderSidePort)
      .rederive(tx, { orderItemIds: rows.map((r) => r.orderItemId) });
  return count;
}
async function assignOne(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  id: string,
  staffId: string,
  note?: string,
) {
  const t = await ticketOf(tx, id);
  if (t.step !== "assigning") throw new AppError("STATE_NOT_ALLOWED");
  if (t.pauseCount > 0)
    throw new AppError("TICKET_ON_HOLD", {
      details: { reasons: t.deliveryTicketPauses.map((r) => r.reason) },
    });
  const now = deps.clock.now();
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_ticket",
    stateField: "step",
    id,
    event: "ticket.assign",
    args: checked(),
    entityId: t.entityId,
    storeId: t.storeId,
    note,
    set: {
      delivery_manager_id: staffId,
      assigned_at: now,
      step_entered_at: now,
      step_due_at: null,
      waiting_on: "staff",
    },
    emit: {
      type: "ticket.assigned",
      payload: {
        v: 1,
        deliveryTicketId: id,
        dramaOrderId: t.dramaOrderId,
        deliveryManagerId: staffId,
      },
    },
  });
}
export async function assignManager(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: { staffId: string; note?: string },
) {
  const visible = await ticketOf(tx, id, staff);
  await lockRows(tx, "staff", [input.staffId], "share");
  const selected = await tx.staff.findUnique({ where: { id: input.staffId } });
  const reason =
    !selected || selected.status !== "active"
      ? "not_active"
      : selected.staffRoleKey !== "delivery_manager"
        ? "role_mismatch"
        : !scopeCovers(staff.scope, input.staffId)
          ? "out_of_scope"
          : visible.deliveryManagerId === input.staffId
            ? "same_as_current"
            : null;
  if (reason)
    throw new AppError("ASSIGNEE_INVALID", { details: { staffId: input.staffId, reason } });
  await lockRows(tx, "store", [visible.storeId]);
  const store = await tx.store.findUniqueOrThrow({ where: { id: visible.storeId } });
  if (!store.deliveryManagerId) {
    // profile 会在同事务同步订单，再调用本模块唯一的 bulk 实现，最后写门店。
    assignmentTargets.set(tx, { id, staff });
    try {
      await deps.profile.assignDeliveryManager(tx, ctx, {
        storeId: visible.storeId,
        ...input,
        scope: staff.scope,
      });
    } finally {
      assignmentTargets.delete(tx);
    }
  } else {
    await lockTickets(tx, [id]);
    const fresh = await ticketOf(tx, id, staff);
    await assignOne(tx, deps, ctx, fresh.id, input.staffId, input.note);
    await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: [fresh.orderItemId] });
  }
}
