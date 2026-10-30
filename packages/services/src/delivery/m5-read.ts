import type { TicketRemindBody } from "@liyoxi/contract";
import { chainOf, findTransitions } from "@liyoxi/shared/machines";
import { calendarDate } from "@liyoxi/shared/time";
import { hasPermission, satisfiesLevel } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import type { TicketRow } from "./repo.js";

type ReminderScene = TicketRemindBody["scene"];
const reminderScenes: readonly ReminderScene[] = ["confirm_plan", "confirm_sample", "golive"];

/** The writer and read projection use the same owner and lifecycle predicates. */
export function canRemindTicket(t: TicketRow, staff: StaffContext, scene: ReminderScene) {
  return (
    satisfiesLevel(staff.moduleLevels.delivery, "view") &&
    (staff.staff.isLead ||
      staff.staff.roleKey === "super_admin" ||
      t.deliveryManagerId === staff.staff.id ||
      (scene === "golive" && t.publisherId === staff.staff.id))
  );
}

export function ticketReminderApplicable(
  t: TicketRow,
  scene: ReminderScene,
  currentSamplePushed: boolean,
) {
  if (t.pauseCount) return false;
  if (scene === "confirm_plan")
    return t.step === "plan_confirm" && t.dramaOrder.deliveryPlan?.status === "pending_confirm";
  if (scene === "confirm_sample") return t.step === "sample_confirm" && currentSamplePushed;
  return (
    ["awaiting_launch", "launch_verify"].includes(t.step) &&
    t.launchTasks.some((l) => !l.isLive && ["pending", "need_fix"].includes(l.reviewStatus))
  );
}

export async function ticketReminderScenes(
  tx: Tx,
  t: TicketRow,
  staff: StaffContext,
  now: Date,
  samples: readonly { versionNo: number; status: string }[],
): Promise<ReminderScene[]> {
  const currentSamplePushed = samples.some(
    (s) => s.versionNo === t.currentSampleVersionNo && s.status === "pushed",
  );
  const applicable = reminderScenes.filter(
    (scene) =>
      canRemindTicket(t, staff, scene) && ticketReminderApplicable(t, scene, currentSamplePushed),
  );
  if (!applicable.length) return [];
  const sent = await tx.manualReminderLog.findMany({
    where: {
      bizDate: new Date(calendarDate(now)),
      OR: applicable.map((scene) => ({
        scene,
        subjectType: scene === "golive" ? "order_item" : "delivery_ticket",
        subjectId: scene === "golive" ? t.orderItemId : t.id,
      })),
    },
    select: { scene: true },
  });
  return applicable.filter((scene) => !sent.some((row) => row.scene === scene));
}

/** ticketOf has already enforced the current task scope; step-up remains a write-time check. */
export function ticketM5Actions(
  t: TicketRow,
  staff: StaffContext,
  now: Date,
  hasOpenReissue: boolean,
  scenes: readonly ReminderScene[],
) {
  if (!satisfiesLevel(staff.moduleLevels.delivery, "view")) return [];
  const actions: string[] = [],
    editable = satisfiesLevel(staff.moduleLevels.delivery, "edit"),
    terminal = ["archived", "terminated"].includes(t.step);
  if (!terminal && editable && hasPermission(staff, "delivery.ticket.assign_editor"))
    actions.push("assign-editor");
  // Publisher leads have delivery=view and a distinct assignment permission.
  if (!terminal && hasPermission(staff, "delivery.ticket.assign_publisher"))
    actions.push("assign-publisher");
  if (scenes.length) actions.push("remind");
  if (
    editable &&
    !t.pauseCount &&
    ["batch_compose", "delivering"].includes(t.step) &&
    !t.deliveredAt &&
    hasPermission(staff, "delivery.ticket.rework")
  )
    actions.push("rework");
  if (
    editable &&
    !t.pauseCount &&
    ["awaiting_launch", "launch_verify", "in_service"].includes(t.step) &&
    calendarDate(now) <= t.orderItem.usageEndDate.toISOString().slice(0, 10) &&
    !hasOpenReissue &&
    hasPermission(staff, "delivery.package.reissue")
  )
    actions.push("reissue");
  // Re-evaluation explicitly supports paused/terminal objects and returns a skipped reason.
  if (hasPermission(staff, "flow.ops.manage")) actions.push("reevaluate");
  if (
    !t.pauseCount &&
    hasPermission(staff, "flow.admin.transition") &&
    findTransitions(chainOf("delivery_ticket", "step"), t.step, "admin.force").length
  )
    actions.push("force-transition");
  return actions;
}
