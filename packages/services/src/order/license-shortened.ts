import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { AppError, alertsOf, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import { createLicenseFollowUp } from "../staff/index.js";
import type { OrderStartBinding } from "./start-binding.js";

/** A shortened license is an operator task. Order dates and money remain untouched. */
export async function onOrderLicenseShortened(
  tx: Tx,
  deps: OrderStartBinding,
  event: DeliveredEvent,
) {
  if (event.type !== "drama.license_shortened") return;
  const payload = EVENT_PAYLOAD_SCHEMAS["drama.license_shortened"].parse(event.payload),
    candidates = await tx.orderItem.findMany({
      where: {
        dramaId: payload.dramaId,
        usageEndSource: "license",
        phase: { notIn: ["cancelled", "refunded", "ended", "terminated"] },
      },
      include: { dramaOrder: true, deliveryTicket: true },
      orderBy: { id: "asc" },
    }),
    operators = await tx.staff.findMany({
      where: { status: "active", staffRoleKey: "content_ops" },
      select: { id: true },
    });
  const staffIds = [
    ...new Set([
      ...operators.map((r) => r.id),
      ...candidates.flatMap((r) =>
        r.dramaOrder.deliveryManagerId ? [r.dramaOrder.deliveryManagerId] : [],
      ),
    ]),
  ].sort();
  await lockRows(tx, "staff", staffIds);
  const currentOperators = await tx.staff.findMany({
    where: { status: "active", staffRoleKey: "content_ops" },
    select: { id: true },
  });
  if (
    JSON.stringify(currentOperators.map((r) => r.id).sort()) !==
    JSON.stringify(operators.map((r) => r.id).sort())
  )
    throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "drama", [payload.dramaId]);
  const copyright = await tx.dramaCopyright.findUnique({
      where: { dramaId: payload.dramaId },
      include: { currentDramaCopyrightRevision: true },
    }),
    revision = copyright?.currentDramaCopyrightRevision;
  if (
    !copyright?.licenseEndDate ||
    !revision ||
    revision.id !== payload.dramaCopyrightRevisionId ||
    !revision.prevEndDate ||
    revision.newEndDate >= revision.prevEndDate ||
    copyright.licenseEndDate.getTime() !== revision.newEndDate.getTime()
  )
    return;
  const end = revision.newEndDate,
    today = calendarDate(deps.clock.now());
  await lockRows(tx, "drama_order", [...new Set(candidates.map((r) => r.dramaOrderId))].sort());
  await lockRows(
    tx,
    "order_item",
    candidates.map((r) => r.id),
  );
  let affected = 0,
    created = 0;
  const unassignedItems: string[] = [];
  const unavailableOwners = new Set<string>();
  for (const candidate of candidates) {
    const row = await tx.orderItem.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { dramaOrder: true, deliveryTicket: true },
    });
    if (
      row.usageEndSource !== "license" ||
      row.usageEndDate <= end ||
      calendarDate(row.usageEndDate) < today ||
      ["cancelled", "refunded", "ended", "terminated"].includes(row.phase) ||
      row.dramaOrder.openCancelRequestId ||
      ["cancelled", "refunded", "ended"].includes(row.dramaOrder.status) ||
      (row.deliveryTicket &&
        ["takedown", "archived", "terminated"].includes(row.deliveryTicket.step))
    )
      continue;
    const owners = [
      ...new Set([
        ...operators.map((r) => r.id),
        ...(row.dramaOrder.deliveryManagerId ? [row.dramaOrder.deliveryManagerId] : []),
      ]),
    ];
    if (owners.some((id) => !staffIds.includes(id))) throw new AppError("PRECONDITION_CHANGED");
    if (!owners.length) unassignedItems.push(row.id);
    for (const ownerStaffId of owners) {
      const outcome = await createLicenseFollowUp(tx, deps.assembly, {
        orderItemId: row.id,
        ownerStaffId,
        revisionId: revision.id,
        licenseEndDate: calendarDate(end),
        now: deps.clock.now(),
      });
      if (outcome === "unavailable") unavailableOwners.add(ownerStaffId);
      if (outcome === "created") created++;
    }
    affected++;
  }
  if (affected && (created || unavailableOwners.size || unassignedItems.length))
    await alertsOf(deps.assembly).raise({
      rule: "order.license_shortened",
      dimension: `${payload.dramaId}:${revision.id}`,
      severity: "P2",
      detail: {
        dramaId: payload.dramaId,
        dramaCopyrightRevisionId: revision.id,
        licenseEndDate: calendarDate(end),
        affectedItems: affected,
        unavailableOwnerStaffIds: [...unavailableOwners].sort(),
        unassignedOrderItemIds: unassignedItems,
      },
    });
}
