import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import { readCurrentLicenseEnd } from "../content/index.js";
import { extendDeliveryUsage, prepareReevaluation, reevaluate } from "../delivery/index.js";
import type { DeliveryCoreDeps } from "../delivery/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, FiredTimer, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import type { Timers } from "../timers/index.js";

const terminal = ["cancelled", "refunded", "ended", "terminated"];
/** Dates are canonical SQL dates, never local-time conversions or elapsed-day arithmetic. */
export function usageExtensionTarget(input: {
  source: string;
  phase: string;
  step?: string;
  oldEnd: string;
  currentEnd: string | null;
  currentRevision: string | null;
  revision: string;
  cancelled: boolean;
}) {
  return input.source === "license" &&
    !terminal.includes(input.phase) &&
    !input.cancelled &&
    !["takedown", "archived", "terminated"].includes(input.step ?? "") &&
    input.currentRevision === input.revision &&
    input.currentEnd !== null &&
    input.currentEnd > input.oldEnd
    ? input.currentEnd
    : null;
}

export function createUsageLifecycle(deps: DeliveryCoreDeps, timers: Pick<Timers, "arm">) {
  async function lockItem(tx: Tx, id: string) {
    const first = await tx.orderItem.findUnique({
      where: { id },
      include: { deliveryTicket: true },
    });
    if (!first) return null;
    if (first.deliveryTicket) await prepareReevaluation(tx, [first.deliveryTicket.id]);
    else {
      await lockRows(tx, "drama", [first.dramaId], "share");
      await lockRows(tx, "drama_order", [first.dramaOrderId]);
      await lockRows(tx, "order_item", [id]);
    }
    return tx.orderItem.findUniqueOrThrow({
      where: { id },
      include: { deliveryTicket: true, dramaOrder: true },
    });
  }
  return {
    async onLicenseExtended(tx: Tx, event: DeliveredEvent) {
      const p = EVENT_PAYLOAD_SCHEMAS["drama.license_extended"].parse(event.payload);
      await lockRows(tx, "drama", [p.dramaId], "share");
      const current = await readCurrentLicenseEnd(tx, p.dramaId);
      if (
        !current?.licenseEndDate ||
        current.currentRevisionId !== p.dramaCopyrightRevisionId ||
        p.newEndDate <= p.prevEndDate
      )
        return;
      const rows = await tx.orderItem.findMany({
        where: { dramaId: p.dramaId, usageEndSource: "license", phase: { notIn: terminal } },
        orderBy: { id: "asc" },
      });
      await lockRows(
        tx,
        "drama_order",
        rows.map((r) => r.dramaOrderId),
      );
      await lockRows(
        tx,
        "order_item",
        rows.map((r) => r.id),
      );
      for (const { id } of rows) {
        const item = await tx.orderItem.findUniqueOrThrow({
          where: { id },
          include: { dramaOrder: true, deliveryTicket: true },
        });
        if (
          !usageExtensionTarget({
            source: item.usageEndSource,
            phase: item.phase,
            ...(item.deliveryTicket ? { step: item.deliveryTicket.step } : {}),
            oldEnd: item.usageEndDate.toISOString().slice(0, 10),
            currentEnd: current.licenseEndDate,
            currentRevision: current.currentRevisionId,
            revision: p.dramaCopyrightRevisionId,
            cancelled:
              !!item.dramaOrder.openCancelRequestId ||
              ["ended", "cancelled", "refunded"].includes(item.dramaOrder.status),
          })
        )
          continue;
        const subject = { type: "order_item", id },
          key = timerKey("usage.resync", subject, p.dramaCopyrightRevisionId);
        if (await tx.timer.count({ where: { dedupeKey: key, status: { not: "cancelled" } } }))
          continue;
        await timers.arm(tx, {
          kind: "usage.resync",
          subject,
          key,
          fireAt: deps.clock.now(),
          entityId: item.entityId,
          storeId: item.storeId,
          payload: {
            v: 1,
            dramaId: p.dramaId,
            dramaCopyrightRevisionId: p.dramaCopyrightRevisionId,
          },
        });
      }
    },
    async handle(tx: Tx, timer: FiredTimer) {
      if (timer.subjectType !== "order_item" || !timer.subjectId) return "skipped" as const;
      const item = await lockItem(tx, timer.subjectId);
      if (
        !item ||
        terminal.includes(item.phase) ||
        ["ended", "cancelled", "refunded"].includes(item.dramaOrder.status)
      )
        return "skipped" as const;
      // A temporary review must retry: the same revision key is not recreated by reconciliation.
      if (item.dramaOrder.openCancelRequestId && timer.kind === "usage.resync")
        throw new AppError("PRECONDITION_CHANGED", { message: "取消审查期间稍后重算使用期" });
      const stored = await tx.timer.findUnique({ where: { id: timer.id } });
      if (!stored || stored.status === "cancelled") return "skipped" as const;
      const oldEnd = item.usageEndDate.toISOString().slice(0, 10),
        ticket = item.deliveryTicket;
      const ctx = createIdentityContext({ actor: { type: "system", job: timer.kind } });
      if (timer.kind === "usage.end") {
        if (
          !ticket ||
          !["awaiting_launch", "launch_verify", "in_service"].includes(ticket.step) ||
          stored.dedupeKey !== timerKey("usage.end", { type: "order_item", id: item.id }, oldEnd) ||
          calendarDate(deps.clock.now()) <= oldEnd
        )
          return "skipped" as const;
        return (await reevaluate(tx, deps, ctx, ticket.id)).moved
          ? ("fired" as const)
          : ("skipped" as const);
      }
      const current = await readCurrentLicenseEnd(tx, item.dramaId);
      if (
        !current?.currentRevisionId ||
        stored.dedupeKey !==
          timerKey("usage.resync", { type: "order_item", id: item.id }, current.currentRevisionId)
      )
        return "skipped" as const;
      const next = usageExtensionTarget({
        source: item.usageEndSource,
        phase: item.phase,
        ...(ticket ? { step: ticket.step } : {}),
        oldEnd,
        currentEnd: current.licenseEndDate,
        currentRevision: current.currentRevisionId,
        revision: current.currentRevisionId,
        cancelled: false,
      });
      if (!next) return "skipped" as const;
      await tx.orderItem.update({
        where: { id: item.id },
        data: { usageEndDate: new Date(next), updatedAt: deps.clock.now() },
      });
      if (ticket) await extendDeliveryUsage(tx, deps, ctx, ticket.id);
      await record(
        tx,
        ctx.actor,
        {
          requestId: ctx.requestId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          sessionId: null,
          authMethod: null,
        },
        {
          stream: "activity",
          category: "delivery",
          action: "order.item.usage_resync",
          summary: "版权续期顺延使用期",
          target: { type: "order_item", id: item.id },
          entityId: item.entityId,
          storeId: item.storeId,
          before: { usageEndDate: oldEnd },
          after: { usageEndDate: next },
          fields: ["usageEndDate"],
        },
      );
      await deps.events.emit(tx, ctx, {
        type: "order.item.usage_end_changed",
        aggregate: { type: "order_item", id: item.id },
        entityId: item.entityId,
        storeId: item.storeId,
        dedupeKey: `usage.resync:${item.id}:${current.currentRevisionId}`,
        payload: {
          v: 1,
          orderItemId: item.id,
          dramaOrderId: item.dramaOrderId,
          prevEndDate: oldEnd,
          newEndDate: next,
          usageEndSource: "license",
        },
      });
      return "fired" as const;
    },
  };
}
export type UsageLifecycle = ReturnType<typeof createUsageLifecycle>;
