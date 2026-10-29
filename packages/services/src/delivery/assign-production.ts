import { scopeCovers } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, actorColumns, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { lifecycleAudit } from "./lifecycle-audit.js";
import { lockTickets, ticketOf } from "./repo.js";

/** Candidate visibility never substitutes for assignment authority. */
export async function assignProductionStaff(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  role: "editor" | "publisher",
  body: { staffId: string; reasonCode?: string; note?: string },
) {
  await ticketOf(tx, id, staff);
  await lockRows(tx, "staff", [body.staffId], "share");
  const target = await tx.staff.findUnique({ where: { id: body.staffId } });
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id, staff);
  if (["archived", "terminated"].includes(t.step)) throw new AppError("STATE_NOT_ALLOWED");
  const field = role === "editor" ? "editorId" : "publisherId",
    from = t[field];
  const reason =
    !target || target.status !== "active"
      ? "not_active"
      : target.staffRoleKey !== role
        ? "role_mismatch"
        : !scopeCovers(staff.scope, body.staffId)
          ? "out_of_scope"
          : from === body.staffId
            ? "same_as_current"
            : null;
  if (reason)
    throw new AppError("ASSIGNEE_INVALID", { details: { staffId: body.staffId, reason } });
  if (
    from &&
    !["workload", "merchant_request", "staff_change", "other"].includes(body.reasonCode ?? "")
  )
    throw new AppError("VALIDATION_FAILED", { message: "改派必须填写原因" });
  if (!from && body.reasonCode)
    throw new AppError("VALIDATION_FAILED", { message: "首次指派不填改派原因" });
  const now = deps.clock.now();
  await tx.deliveryTicket.update({
    where: { id },
    data: { [field]: body.staffId, updatedAt: now },
  });
  if (from)
    await tx.assignmentHistory.create({
      data: {
        id: uuidv7(),
        batchId: uuidv7(),
        source: `ticket_${role}`,
        subjectType: "delivery_ticket",
        subjectId: id,
        fromStaffId: from,
        toStaffId: body.staffId,
        reasonCode: body.reasonCode!,
        note: body.note ?? null,
        ...actorColumns(ctx.actor),
        createdAt: now,
        updatedAt: now,
      },
    });
  await lifecycleAudit(tx, ctx, {
    stream: "activity",
    category: "delivery",
    action:
      role === "editor" ? "delivery.ticket.assign_editor" : "delivery.ticket.assign_publisher",
    summary: role === "editor" ? "指派剪辑师" : "指派发布专员",
    target: { type: "delivery_ticket", id },
    entityId: t.entityId,
    storeId: t.storeId,
    before: { [field]: from },
    after: { [field]: body.staffId },
    fields: [field],
    reason: { code: body.reasonCode ?? "other", text: body.note ?? null },
  });
}
