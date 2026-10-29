import { assertAccess } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { MediaActor } from "../media/index.js";
import { lockTickets, ticketScope } from "./repo.js";

/** L4 injects this owner reader into media; file scope never substitutes for parent scope. */
export async function requireProductionAccess(
  tx: Tx,
  actor: MediaActor,
  parent: { orderItemId: string | null; adId: string | null },
  permission?: "production.normalize" | "production.restamp" | "production.recheck",
): Promise<void> {
  const staff = actor.staff;
  if (!staff || actor.identity.actor.type !== "staff" || actor.identity.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertAccess(staff, {
    module: { module: "delivery", need: "view" },
    permission: permission ?? null,
  });
  if ((parent.orderItemId === null) === (parent.adId === null)) throw new AppError("NOT_FOUND");
  if (parent.orderItemId) {
    if (permission) {
      const found = await tx.deliveryTicket.findFirst({
        where: { orderItemId: parent.orderItemId, ...ticketScope(staff) },
        select: { id: true },
      });
      if (!found) throw new AppError("NOT_FOUND");
      await lockTickets(tx, [found.id]);
    }
    const ticket = await tx.deliveryTicket.findFirst({
      where: { orderItemId: parent.orderItemId, ...ticketScope(staff) },
      select: {
        entityId: true,
        storeId: true,
        dramaOrderId: true,
        orderItem: { select: { entityId: true, storeId: true, dramaOrderId: true } },
      },
    });
    if (
      !ticket ||
      ticket.entityId !== ticket.orderItem.entityId ||
      ticket.storeId !== ticket.orderItem.storeId ||
      ticket.dramaOrderId !== ticket.orderItem.dramaOrderId
    )
      throw new AppError("NOT_FOUND");
    return;
  }
  throw new AppError("NOT_FOUND");
}
