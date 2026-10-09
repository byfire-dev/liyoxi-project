import { assertAccess, scopeCovers } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { lockTickets } from "./repo.js";

/** Field ownership stays with delivery; derived launch, patrol and takedown handlers read this field. */
export async function assignPublisher(
  tx: Tx,
  input: {
    ticketId: string;
    publisherId: string;
    staff: StaffContext;
    ctx: IdentityContext;
    now: Date;
  },
) {
  assertAccess(input.staff, {
    module: { module: "delivery", need: "view" },
    permission: "delivery.ticket.assign_publisher",
  });
  await lockRows(tx, "staff", [input.publisherId], "share");
  const target = await tx.staff.findUnique({ where: { id: input.publisherId } });
  if (!target || target.status !== "active" || target.staffRoleKey !== "publisher")
    throw new AppError("ASSIGNEE_INVALID", {
      details: {
        staffId: input.publisherId,
        reason: !target || target.status !== "active" ? "not_active" : "role_mismatch",
      },
    });
  const first = await tx.deliveryTicket.findUnique({ where: { id: input.ticketId } });
  if (!first) throw new AppError("NOT_FOUND");
  await lockRows(tx, "store", [first.storeId]);
  await lockTickets(tx, [first.id]);
  const current = await tx.deliveryTicket.findUniqueOrThrow({ where: { id: first.id } });
  if (!scopeCovers(input.staff.scope, current.deliveryManagerId)) throw new AppError("NOT_FOUND");
  if (
    current.step === "archived" ||
    (current.step === "terminated" &&
      !(await tx.takedownTask.count({
        where: { deliveryTicketId: current.id, status: { notIn: ["checked", "void"] } },
      })))
  )
    throw new AppError("STATE_NOT_ALLOWED");
  await tx.deliveryTicket.update({
    where: { id: current.id },
    data: { publisherId: target.id, updatedAt: input.now },
  });
  await record(
    tx,
    input.ctx.actor,
    {
      requestId: input.ctx.requestId,
      ip: input.ctx.ip,
      userAgent: input.ctx.userAgent,
      sessionId: null,
      authMethod: null,
    },
    {
      stream: "ops",
      category: "delivery",
      action: "delivery.ticket.assign_publisher",
      summary: "指派发布专员",
      target: { type: "delivery_ticket", id: current.id },
      entityId: current.entityId,
      storeId: current.storeId,
      before: { publisherId: current.publisherId },
      after: { publisherId: target.id },
      fields: ["publisherId"],
    },
  );
  return { ticketId: current.id, publisherId: target.id };
}
