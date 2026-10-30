import { PlanContentSchema } from "@liyoxi/contract";
import type {
  AssignStaffBody,
  ForceTransitionBody,
  ReworkBody,
  RescheduleLaunchBody,
  TicketRemindBody,
  ReissueCreateBody,
  ReissueCancelBody,
  ReissuePublishBody,
} from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { assertAccess, assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { AdminFlow } from "../flow/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import type { DeliveryDeps, DeliveryWriteOptions } from "./context.js";
import { assignProductionStaff } from "./assign-production.js";
import { lifecycleAudit } from "./lifecycle-audit.js";
import { checked } from "./machines.js";
import { dateOf, lockTickets, ticketOf } from "./repo.js";
import { adsReady, reevaluate } from "./reevaluate.js";
import { moveSample } from "./sample-transitions.js";
import { unpaused } from "./quality.js";
import { ticketCard, ticketDetail } from "./views.js";
import { createReissue, cancelReissue, publishReissue } from "./reissue.js";
import { ticketActivities } from "./ticket-activities.js";
import { prepareReevaluation } from "./reevaluate-locks.js";
import { canRemindTicket, ticketReminderApplicable } from "./m5-read.js";

export interface DeliveryM5Deps extends DeliveryDeps {
  readonly flow: AdminFlow;
}
export function createDeliveryM5(deps: DeliveryM5Deps) {
  const permission = (staff: StaffContext, key: Parameters<typeof assertPermission>[1]) => {
    assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
    assertPermission(staff, key, deps.clock.now());
  };
  const detail = async (tx: Tx, staff: StaffContext, id: string) =>
    ticketDetail(tx, deps, await ticketOf(tx, id, staff), staff, deps.clock.now());
  const write = async <T>(options: DeliveryWriteOptions, run: (tx: Tx) => Promise<T>) => ({
    ...(await deps.tx.run(run, options)),
    replayed: options.idem?.replayed ?? false,
  });
  return {
    activityList: async (
      staff: StaffContext,
      id: string,
      query: { cursor?: string; limit: number },
    ) => {
      assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
      return deps.tx.run(async (tx) => ticketActivities(tx, await ticketOf(tx, id, staff), query));
    },
    assignEditor: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: AssignStaffBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "delivery.ticket.assign_editor");
      return write(options, async (tx) => {
        await assignProductionStaff(tx, deps, ctx, staff, id, "editor", body);
        return detail(tx, staff, id);
      });
    },
    assignPublisher: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: AssignStaffBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "delivery.ticket.assign_publisher");
      return write(options, async (tx) => {
        await assignProductionStaff(tx, deps, ctx, staff, id, "publisher", body);
        return detail(tx, staff, id);
      });
    },
    forceTransition: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ForceTransitionBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "flow.admin.transition");
      return write(options, async (tx) => {
        await ticketOf(tx, id, staff);
        await prepareReevaluation(tx, [id], { staffIds: [staff.staff.id] });
        const t = await ticketOf(tx, id, staff);
        await deps.flow.adminTransition(tx, ctx, staff, {
          machine: "delivery_ticket",
          stateField: "step",
          id,
          to: body.toStep,
          note: body.note,
          args: body,
          entityId: t.entityId,
          storeId: t.storeId,
          set: {
            step_entered_at: deps.clock.now(),
            step_due_at: null,
            waiting_on: body.toStep === "in_service" ? "none" : "staff",
          },
          audit: {
            stream: "ops",
            category: "system_ops",
            action: "delivery.ticket.force_transition",
            summary: "人工纠偏交付工单",
            target: { type: "delivery_ticket", id },
            entityId: t.entityId,
            storeId: t.storeId,
          },
          emit: {
            type: "ticket.step_changed",
            payload: {
              v: 1,
              deliveryTicketId: id,
              dramaOrderId: t.dramaOrderId,
              orderItemId: t.orderItemId,
              isForced: true,
            },
          },
        });
        return detail(tx, staff, id);
      });
    },
    reevaluate: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      _body: Record<string, never>,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "flow.ops.manage");
      return write(options, async (tx) => {
        await ticketOf(tx, id, staff);
        await prepareReevaluation(tx, [id]);
        const t = await ticketOf(tx, id, staff),
          latest = await tx.statusTransition.findFirst({
            where: { machine: "delivery_ticket", subjectId: id },
            orderBy: { seq: "desc" },
          });
        const skippedReason = t.pauseCount
          ? ("paused" as const)
          : ["archived", "terminated"].includes(t.step)
            ? ("terminal" as const)
            : null;
        if (!skippedReason) await reevaluate(tx, deps, ctx, id);
        const histories = await tx.statusTransition.findMany({
          where: { machine: "delivery_ticket", subjectId: id, seq: { gt: latest?.seq ?? 0n } },
          orderBy: { seq: "asc" },
        });
        const transitions = histories.map((h) => ({
          event: h.event,
          fromStep: h.fromState!,
          toStep: h.toState,
        }));
        await lifecycleAudit(tx, ctx, {
          stream: "ops",
          category: "system_ops",
          action: "delivery.ticket.reevaluate",
          summary: "重新求值交付工单",
          target: { type: "delivery_ticket", id },
          entityId: t.entityId,
          storeId: t.storeId,
          meta: { transitions },
        });
        return {
          transitions,
          skippedReason,
          ticket: await ticketCard(tx, await ticketOf(tx, id, staff), staff, deps.clock.now()),
        };
      });
    },
    rework: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ReworkBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "delivery.ticket.rework");
      return write(options, async (tx) => {
        const initial = await ticketOf(tx, id, staff);
        await lockRows(
          tx,
          "ad",
          initial.orderItem.orderItemPlacements.map((p) => p.adId),
          "share",
        );
        await lockTickets(tx, [id]);
        const t = await ticketOf(tx, id, staff);
        unpaused(t);
        if (!["batch_compose", "delivering"].includes(t.step) || t.deliveredAt)
          throw new AppError("STATE_NOT_ALLOWED");
        const episodes = await tx.episodeOutput.findMany({
          where: { deliveryTicketId: id, isCurrent: true, status: "qc_passed" },
        });
        const samples = await tx.sample.findMany({
          where: { deliveryTicketId: id, status: "confirmed" },
        });
        await lockRows(
          tx,
          "episode_output",
          episodes.map((e) => e.id),
        );
        await lockRows(
          tx,
          "sample",
          samples.map((s) => s.id),
        );
        const now = deps.clock.now();
        await tx.orderItemPlacement.updateMany({
          where: { orderItemId: t.orderItemId },
          data: { boundVersionNo: null, pinnedAt: null, updatedAt: now },
        });
        for (const s of samples) await moveSample(tx, deps, ctx, t, s, "sample.superseded");
        await tx.episodeOutput.updateMany({
          where: { id: { in: episodes.map((e) => e.id) } },
          data: { status: "replaced", isCurrent: false, updatedAt: now },
        });
        await deps.flow.transition(tx, ctx, {
          machine: "delivery_ticket",
          stateField: "step",
          id,
          event: "ticket.rework",
          to: adsReady(t) ? "sample_making" : "ad_prep",
          args: checked(),
          note: body.reason,
          entityId: t.entityId,
          storeId: t.storeId,
          set: { step_entered_at: now, step_due_at: null, waiting_on: "staff" },
          emit: {
            type: "ticket.step_changed",
            payload: {
              v: 1,
              deliveryTicketId: id,
              dramaOrderId: t.dramaOrderId,
              orderItemId: t.orderItemId,
              isForced: false,
            },
          },
        });
        return detail(tx, staff, id);
      });
    },
    rescheduleLaunch: async (
      ctx: IdentityContext,
      staff: StaffContext,
      itemId: string,
      body: RescheduleLaunchBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "delivery.plan.reschedule");
      return write(options, async (tx) => {
        const first = await tx.deliveryTicket.findUnique({ where: { orderItemId: itemId } });
        if (!first) throw new AppError("NOT_FOUND");
        await ticketOf(tx, first.id, staff);
        await lockTickets(tx, [first.id]);
        const t = await ticketOf(tx, first.id, staff),
          item = t.orderItem,
          p = t.dramaOrder.deliveryPlan;
        if (
          item.usageStartDate ||
          !["producing", "awaiting_launch"].includes(item.phase) ||
          t.launchTasks.some((l) => l.isLive)
        )
          throw new AppError("LAUNCH_DATE_LOCKED");
        if (p) await lockRows(tx, "delivery_plan", [p.id]);
        const today = calendarDate(deps.clock.now()),
          ordered = calendarDate(t.dramaOrder.createdAt);
        const earliest = await deps.sla.nthWorkdayAfter(tx, {
          policy: "delivery.launch",
          from: ordered,
          amount: 7,
          workHours: await workHoursAt(tx, deps.clock.now()),
        });
        const minDate = earliest.date > today ? earliest.date : today,
          maxDate = dateOf(item.usageEndDate)!;
        if (body.agreedLaunchDate < minDate || body.agreedLaunchDate > maxDate)
          throw new AppError("LAUNCH_DATE_OUT_OF_RANGE", { details: { minDate, maxDate } });
        const prevDate = dateOf(item.agreedLaunchDate);
        if (prevDate === body.agreedLaunchDate) throw new AppError("VALIDATION_FAILED");
        await tx.orderItem.update({
          where: { id: itemId },
          data: { agreedLaunchDate: new Date(body.agreedLaunchDate), updatedAt: deps.clock.now() },
        });
        if (p) {
          const draft = PlanContentSchema.parse(p.draft);
          await tx.deliveryPlan.update({
            where: { id: p.id },
            data: {
              draft: {
                ...draft,
                items: draft.items.map((i) =>
                  i.orderItemId === itemId ? { ...i, agreedLaunchDate: body.agreedLaunchDate } : i,
                ),
              },
              draftLockVersion: { increment: 1 },
              updatedAt: deps.clock.now(),
            },
          });
        }
        await lifecycleAudit(tx, ctx, {
          stream: "activity",
          category: "delivery",
          action: "delivery.order_item.reschedule_launch",
          summary: "改约定上线日",
          target: { type: "order_item", id: itemId },
          entityId: t.entityId,
          storeId: t.storeId,
          before: { agreedLaunchDate: prevDate },
          after: { agreedLaunchDate: body.agreedLaunchDate },
          fields: ["agreedLaunchDate"],
          reason: { code: "other", text: body.reason },
          meta: {
            orderItemId: itemId,
            deliveryTicketId: t.id,
            prevDate,
            newDate: body.agreedLaunchDate,
          },
        });
        await deps.events.emit(tx, ctx, {
          type: "order.item.launch_rescheduled",
          aggregate: { type: "order_item", id: itemId },
          entityId: t.entityId,
          storeId: t.storeId,
          payload: {
            v: 1,
            orderItemId: itemId,
            dramaOrderId: t.dramaOrderId,
            prevDate,
            newDate: body.agreedLaunchDate,
          },
        });
        return (await detail(tx, staff, t.id)).orderItem;
      });
    },
    remind: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: TicketRemindBody,
      options: DeliveryWriteOptions = {},
    ) => {
      assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
      return write(options, async (tx) => {
        await ticketOf(tx, id, staff);
        await lockTickets(tx, [id]);
        const t = await ticketOf(tx, id, staff);
        unpaused(t);
        if (!canRemindTicket(t, staff, body.scene)) throw new AppError("PERMISSION_DENIED");
        const scene = body.scene;
        const currentSamplePushed =
          scene === "confirm_sample" &&
          (await tx.sample.count({
            where: {
              deliveryTicketId: id,
              versionNo: t.currentSampleVersionNo ?? 0,
              status: "pushed",
            },
          })) > 0;
        if (!ticketReminderApplicable(t, scene, currentSamplePushed))
          throw new AppError("REMIND_NOT_APPLICABLE");
        const now = deps.clock.now(),
          bizDate = calendarDate(now),
          subjectType = scene === "golive" ? "order_item" : "delivery_ticket",
          subjectId = scene === "golive" ? t.orderItemId : id;
        const nextAvailableDate = addDays(bizDate, 1),
          logId = uuidv7();
        const made = await tx.manualReminderLog.createMany({
          data: {
            id: logId,
            subjectType,
            subjectId,
            scene,
            bizDate: new Date(bizDate),
            sentByStaffId: staff.staff.id,
            createdAt: now,
          },
          skipDuplicates: true,
        });
        if (!made.count)
          throw new AppError("REMINDED_TODAY", { details: { scene, nextAvailableDate } });
        await deps.events.emit(tx, ctx, {
          type: "manual_reminder.sent",
          aggregate: { type: "manual_reminder_log", id: logId },
          entityId: t.entityId,
          storeId: t.storeId,
          payload: { v: 1, manualReminderLogId: logId, subjectType, subjectId, scene, bizDate },
        });
        await lifecycleAudit(tx, ctx, {
          stream: "activity",
          category: "delivery",
          action: "delivery.ticket.remind",
          summary: "人工催办商家",
          target: { type: "delivery_ticket", id },
          entityId: t.entityId,
          storeId: t.storeId,
        });
        return { scene, subjectType, subjectId, remindedAt: now.toISOString(), nextAvailableDate };
      });
    },
    reissueCreate: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ReissueCreateBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "delivery.package.reissue");
      return write(options, (tx) => createReissue(tx, deps, ctx, staff, id, body));
    },
    reissueCancel: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ReissueCancelBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "delivery.package.reissue");
      return write(options, (tx) => cancelReissue(tx, deps, ctx, staff, id, body));
    },
    reissuePublish: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: ReissuePublishBody,
      options: DeliveryWriteOptions = {},
    ) => {
      permission(staff, "publish.package.push");
      return write(options, (tx) =>
        publishReissue(tx, deps, ctx, staff, id, body, options.idem?.key ?? uuidv7()),
      );
    },
  };
}
export type DeliveryM5 = ReturnType<typeof createDeliveryM5>;
