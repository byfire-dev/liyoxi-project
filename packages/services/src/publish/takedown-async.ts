import { addDays, dayRange } from "@liyoxi/shared/time";
import { createIdentityContext } from "../kernel/index.js";
import type { FiredTimer, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import { ensureTakedownTasks, readDeliveryPublishTargets } from "./delivery-lifecycle.js";
import { launchChangedPort } from "./ports.js";
import type { TakedownDeps } from "./takedown-context.js";
import { onTakedownCalendarImported } from "./takedown-calendar.js";
import { repairTakedownTimers } from "./takedown-invariants.js";
import { overdueTakedown } from "./takedown-overdue.js";

const dateOf = (value: Date) => value.toISOString().slice(0, 10);
export async function createTakedownsFromTimer(tx: Tx, deps: TakedownDeps, timer: FiredTimer) {
  if (timer.kind !== "takedown.create" || timer.subjectType !== "order_item" || !timer.subjectId)
    return "skipped" as const;
  const first = await tx.deliveryTicket.findUnique({ where: { orderItemId: timer.subjectId } });
  if (!first) return "skipped" as const;
  await deps.assembly.port(launchChangedPort)(tx, {
    orderItemId: first.orderItemId,
    deliveryTicketId: first.id,
    phase: "prelock",
  });
  const ticket = await tx.deliveryTicket.findUniqueOrThrow({
    where: { id: first.id },
    include: { orderItem: true },
  });
  const persisted = await tx.timer.findUnique({ where: { id: timer.id } }),
    now = deps.clock.now();
  if (
    !ticket.orderItem.usageEndDate ||
    !["awaiting_launch", "launch_verify", "in_service", "takedown"].includes(ticket.step)
  )
    return "skipped" as const;
  const end = dateOf(ticket.orderItem.usageEndDate),
    fireAt = dayRange(addDays(end, -30)).start;
  if (
    !persisted ||
    persisted.kind !== timer.kind ||
    persisted.subjectId !== first.orderItemId ||
    persisted.status !== "dispatched" ||
    persisted.dedupeKey !==
      timerKey("takedown.create", { type: "order_item", id: first.orderItemId }, end) ||
    persisted.fireAt.getTime() !== fireAt.getTime() ||
    timer.payload?.usageEndDate !== end ||
    now < fireAt ||
    !(await tx.deliveryRelease.count({ where: { orderItemId: first.orderItemId } }))
  )
    return "skipped" as const;
  await ensureTakedownTasks(
    tx,
    deps,
    createIdentityContext({ actor: { type: "system", job: "takedown.create" } }),
    await readDeliveryPublishTargets(tx, [first.orderItemId]),
    { deliveryTicketId: first.id, now },
  );
  return "fired" as const;
}
export function createTakedownAsync(deps: TakedownDeps) {
  return {
    create: (tx: Tx, timer: FiredTimer) => createTakedownsFromTimer(tx, deps, timer),
    overdue: (tx: Tx, timer: FiredTimer) => overdueTakedown(tx, deps, timer),
    onCalendarImported: (tx: Tx, event: Parameters<typeof onTakedownCalendarImported>[2]) =>
      onTakedownCalendarImported(tx, deps, event),
    reconcileTimers: (tx: Tx, now: Date) => repairTakedownTimers(tx, deps, now),
  };
}
