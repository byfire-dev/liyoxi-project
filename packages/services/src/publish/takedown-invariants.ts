import { addDays, atMinuteOfDay, calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { InvariantViolation, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import { ensureTakedownTasks, readDeliveryPublishTargets } from "./delivery-lifecycle.js";
import { launchChangedPort } from "./ports.js";
import type { TakedownDeps } from "./takedown-context.js";

export const TAKEDOWN_INVARIANT_CODES = ["I16", "I17", "I18", "I19", "I20"] as const;
const dateOf = (d: Date) => d.toISOString().slice(0, 10);
async function missingTakedowns(tx: Tx, now: Date) {
  const tickets = await tx.deliveryTicket.findMany({
    where: {
      step: { in: ["awaiting_launch", "launch_verify", "in_service", "takedown"] },
      orderItem: {
        usageEndDate: { lte: new Date(addDays(calendarDate(now), 30)) },
        deliveryReleases: { some: {} },
      },
    },
    include: {
      orderItem: {
        include: { orderItemAccounts: true, takedownTasks: { where: { status: { not: "void" } } } },
      },
    },
    orderBy: { id: "asc" },
  });
  return tickets.flatMap((t) => {
    const missing = t.orderItem.orderItemAccounts.filter(
      (a) => !t.orderItem.takedownTasks.some((r) => r.channelAccountId === a.channelAccountId),
    );
    return missing.length ? [{ ticket: t, missing: missing.map((a) => a.channelAccountId) }] : [];
  });
}
export async function findTakedownViolations(
  tx: Tx,
  code: string,
  now: Date,
): Promise<InvariantViolation[]> {
  if (code === "I16")
    return (await missingTakedowns(tx, now)).map(({ ticket, missing }) => ({
      subject: { type: "order_item", id: ticket.orderItemId },
      entityId: ticket.entityId,
      detail: { missingChannelAccountIds: missing },
    }));
  const rows = await tx.takedownTask.findMany({ include: { launchTask: true, orderItem: true } });
  const violations: InvariantViolation[] = [];
  for (const row of rows) {
    let bad = false;
    const unchecked = ["pending_merchant", "merchant_confirmed"].includes(row.status);
    if (code === "I17" && unchecked)
      bad =
        row.basis !== (row.launchTask.isLive ? "live" : "delivered_unverified") ||
        (row.basis === "live" && row.merchantMethod === "not_published");
    if (code === "I18")
      bad =
        row.entityId !== row.launchTask.entityId ||
        row.storeId !== row.launchTask.storeId ||
        row.orderItemId !== row.launchTask.orderItemId ||
        row.deliveryTicketId !== row.launchTask.deliveryTicketId ||
        row.channelAccountId !== row.launchTask.channelAccountId;
    if (code === "I19" && unchecked) {
      const expiry = ["expiry", "early_end"].includes(row.triggerKind);
      const line = expiry
        ? null
        : await tx.cancelRequestLine.findFirst({
            where: {
              targetType: "order_item",
              targetId: row.orderItemId,
              executedAt: { not: null },
            },
            orderBy: { executedAt: "desc" },
          });
      const expectedDue = expiry
        ? row.orderItem.usageEndDate && dateOf(row.orderItem.usageEndDate)
        : line?.executedAt && addDays(calendarDate(line.executedAt), 1);
      bad =
        !row.orderItem.usageEndDate ||
        dateOf(row.usageEndDate) !== dateOf(row.orderItem.usageEndDate) ||
        dateOf(row.dueDate) !== expectedDue;
    }
    if (code === "I20" && row.checkMethod === "evidence") {
      const refs = await tx.fileRef.findMany({
        where: {
          refType: "takedown_task",
          refId: row.id,
          role: "evidence",
          fileId: { in: row.evidenceFileIds },
          state: "live",
          releasedAt: null,
        },
      });
      bad = row.evidenceFileIds.length < 2 || refs.length !== row.evidenceFileIds.length;
    }
    if (bad)
      violations.push({
        subject: { type: "takedown_task", id: row.id },
        entityId: row.entityId,
        detail: { invariant: code, launchTaskId: row.launchTaskId },
      });
  }
  return violations;
}
/** Heal through the sole writer after delivery prelocks every affected graph once. */
export async function repairMissingTakedowns(
  tx: Tx,
  deps: TakedownDeps,
  now: Date,
): Promise<InvariantViolation[]> {
  const candidates = await missingTakedowns(tx, now);
  const first = candidates[0];
  if (!first) return [];
  await deps.assembly.port(launchChangedPort)(tx, {
    orderItemId: first.ticket.orderItemId,
    deliveryTicketId: first.ticket.id,
    deliveryTicketIds: candidates.map((r) => r.ticket.id).sort(),
    phase: "prelock",
  });
  const current = await missingTakedowns(tx, now),
    violations: InvariantViolation[] = [];
  for (const { ticket, missing } of current.filter((r) =>
    candidates.some((c) => c.ticket.id === r.ticket.id),
  )) {
    await ensureTakedownTasks(
      tx,
      deps,
      createIdentityContext({ actor: { type: "system", job: "publish.takedown_reconcile" } }),
      await readDeliveryPublishTargets(tx, [ticket.orderItemId]),
      { deliveryTicketId: ticket.id, now },
    );
    violations.push({
      subject: { type: "order_item", id: ticket.orderItemId },
      entityId: ticket.entityId,
      detail: { missingChannelAccountIds: missing },
      healed: { action: "补建下架任务", at: now },
    });
  }
  return violations;
}
/** Runs after patrol's rank-260 contribution. This leaf only locks rank-280 tasks. */
export async function repairTakedownTimers(
  tx: Tx,
  deps: TakedownDeps,
  now: Date,
): Promise<InvariantViolation[]> {
  const pending = await tx.takedownTask.findMany({
    where: { status: "pending_merchant" },
    select: { id: true },
  });
  const timers = await tx.timer.findMany({
    where: {
      kind: "takedown.overdue",
      subjectType: "takedown_task",
      status: { in: ["scheduled", "dispatched"] },
    },
  });
  const ids = [
    ...new Set([
      ...pending.map((r) => r.id),
      ...timers.flatMap((r) => (r.subjectId ? [r.subjectId] : [])),
    ]),
  ].sort();
  await lockRows(tx, "takedown_task", ids);
  const violations: InvariantViolation[] = [];
  for (const id of ids) {
    const row = await tx.takedownTask.findUnique({ where: { id } }),
      subject = { type: "takedown_task", id };
    const live = await tx.timer.findMany({
      where: {
        kind: "takedown.overdue",
        subjectType: subject.type,
        subjectId: id,
        status: { in: ["scheduled", "dispatched"] },
      },
    });
    const due = row && dateOf(row.dueDate),
      fireAt = due && atMinuteOfDay(addDays(due, 1), 540);
    const key = due && timerKey("takedown.overdue", subject, due);
    const wrong = live.filter(
      (t) =>
        row?.status !== "pending_merchant" ||
        t.dedupeKey !== key ||
        t.fireAt.getTime() !== (fireAt as Date).getTime(),
    );
    for (const timer of wrong) {
      // Prefix cancellation remains confined to the obsolete generation.
      await deps.timers.cancel(tx, {
        subject,
        kinds: ["takedown.overdue"],
        keyPrefix: timer.dedupeKey,
      });
      const entityId = row?.entityId ?? timer.entityId;
      if (!entityId) throw new TypeError("下架孤儿定时器缺少主体");
      violations.push({
        subject: { type: "timer", id: timer.id },
        entityId,
        detail: { orphan: true },
        healed: { action: "取消失效下架提醒", at: now },
      });
    }
    // Due timers belong to the existing delivery/retry lifecycle, never re-arm them.
    if (row?.status !== "pending_merchant" || !fireAt || fireAt <= now || !key) continue;
    if (
      await tx.timer.findFirst({ where: { dedupeKey: key, fireAt, status: { not: "cancelled" } } })
    )
      continue;
    await deps.timers.arm(tx, {
      kind: "takedown.overdue",
      subject,
      key,
      fireAt,
      entityId: row.entityId,
      storeId: row.storeId,
      payload: { dueDate: due },
    });
    violations.push({
      subject,
      entityId: row.entityId,
      detail: { missing: true },
      healed: { action: "补登记下架逾期提醒", at: now },
    });
  }
  return violations;
}
