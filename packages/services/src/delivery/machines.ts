import { chainKey, machinePort, rowKey } from "../flow/index.js";
import type { MachineBinding, TransitionFacts } from "../flow/index.js";
import { implementKeyed, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
const pass = Symbol("delivery.checked");
export const checked = () => pass;
const legacySampleRecoveryPass = Symbol("delivery.legacy_sample_recovery");
export const legacySampleRecoveryChecked = () => legacySampleRecoveryPass;
export const cancelResumeChecked = (approvalRequestId: string) => ({ pass, approvalRequestId });
const holdPass = Symbol("delivery.cancel_hold");
export const cancelHoldChecked = (approvalRequestId: string) => ({ holdPass, approvalRequestId });
const guards = (rows: ReadonlyArray<readonly [string, string]>) =>
  Object.fromEntries(
    rows.map(([ref, event]) => [
      rowKey(ref, event),
      async (_tx: Tx, facts: TransitionFacts) => facts.args === pass,
    ]),
  );
async function stage(tx: Tx, f: TransitionFacts) {
  if (f.from === f.to) return;
  if (f.from !== null)
    await tx.deliveryTicketStage.updateMany({
      where: { deliveryTicketId: f.subjectId, completedAt: null },
      data: { completedAt: f.now, exitEvent: f.event, updatedAt: f.now },
    });
  if (f.from === null && f.to === "plan_confirm")
    await tx.deliveryTicketStage.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: f.subjectId,
        step: "assigning",
        visitNo: 1,
        enteredAt: f.now,
        completedAt: f.now,
        exitEvent: "ticket.created",
        createdAt: f.now,
        updatedAt: f.now,
      },
    });
  if (!["archived", "terminated"].includes(f.to)) {
    const max = await tx.deliveryTicketStage.aggregate({
      where: { deliveryTicketId: f.subjectId, step: f.to },
      _max: { visitNo: true },
    });
    await tx.deliveryTicketStage.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: f.subjectId,
        step: f.to,
        visitNo: (max._max.visitNo ?? 0) + 1,
        enteredAt: f.now,
        createdAt: f.now,
        updatedAt: f.now,
      },
    });
  }
}
const rows = [
  ["10:196", "ticket.created"],
  ["10:172", "ticket.assign"],
  ["10:173", "plan.confirmed"],
  ["10:174", "ads.ready"],
  ["10:175", "sample.pushed"],
  ["10:176", "sample.confirmed"],
  ["10:180", "episodes.all_passed"],
  ["10:182", "package.pushed"],
  ["10:183", "launch.changed"],
  ["10:184", "launch.changed"],
  ["10:185", "launch.changed"],
] as const;
const ticket: MachineBinding = {
  companions: [
    "step_entered_at",
    "step_due_at",
    "waiting_on",
    "delivery_manager_id",
    "assigned_at",
    "plan_confirmed_at",
    "ads_ready_at",
    "composed_at",
    "live_at",
    "links_submitted_at",
    "current_sample_version_no",
    "sample_first_pushed_at",
    "sample_confirmed_at",
    "delivered_at",
    "editor_id",
    "pause_count",
    "paused_at",
    "pause_remaining_min",
  ],
  guards: {
    ...guards(rows.filter(([ref]) => ref !== "10:196")),
    [rowKey("10:175", "sample.pushed")]: async (_tx, facts) =>
      facts.from === "sample_confirm"
        ? facts.to === "sample_confirm" && facts.args === legacySampleRecoveryPass
        : facts.from === "sample_making" && facts.args === pass,
    [rowKey("10:189", "ticket.hold")]: async (tx, facts) => {
      const args = facts.args as ReturnType<typeof cancelHoldChecked> | undefined;
      if (args?.holdPass !== holdPass) return false;
      const ticket = await tx.deliveryTicket.findUnique({ where: { id: facts.subjectId } });
      const approval = await tx.approvalRequest.findUnique({
        where: { id: args.approvalRequestId },
      });
      if (
        !ticket ||
        !approval ||
        approval.status !== "pending" ||
        approval.entityId !== ticket.entityId ||
        approval.storeId !== ticket.storeId
      )
        return false;
      const active = await tx.deliveryTicketPause.findMany({
        where: { deliveryTicketId: ticket.id, releasedAt: null },
      });
      return (
        active.length === ticket.pauseCount + 1 &&
        active.some(
          (p) =>
            p.reason === "cancel_review" &&
            p.refType === "approval_request" &&
            p.refId === approval.id,
        )
      );
    },
    [rowKey("10:190", "ticket.resume")]: async (tx, facts) => {
      const args = facts.args as ReturnType<typeof cancelResumeChecked> | undefined;
      if (args?.pass !== pass) return false;
      const ticket = await tx.deliveryTicket.findUnique({ where: { id: facts.subjectId } });
      return (
        !!ticket &&
        ticket.pauseCount > 0 &&
        !!(await tx.deliveryTicketPause.findFirst({
          where: {
            deliveryTicketId: ticket.id,
            reason: "cancel_review",
            refType: "approval_request",
            refId: args.approvalRequestId,
            releasedAt: null,
          },
        }))
      );
    },
  },
  effects: Object.fromEntries(rows.map(([ref, event]) => [rowKey(ref, event), stage])),
  activity: (f) => ({
    category: "delivery",
    action: `delivery.ticket.${f.event.split(".")[1]}`,
    summary: "交付工单环节变化",
  }),
};
const plan: MachineBinding = {
  companions: [
    "current_version_no",
    "pushed_at",
    "confirmed_version_no",
    "confirmed_at",
    "staff_due_at",
  ],
  guards: guards([
    ["10:417", "plan.push"],
    ["10:418", "plan.confirm"],
    ["10:419", "plan.request_change"],
  ]),
  activity: (f) => ({
    category: "delivery",
    action: `delivery.plan.${f.event.split(".")[1]}`,
    summary: "交付方案处理",
  }),
};
export const deliveryMachines = [
  implementKeyed(machinePort, chainKey("delivery_ticket", "step"), ticket),
  implementKeyed(machinePort, chainKey("delivery_plan", "status"), plan),
  implementKeyed(machinePort, chainKey("sample", "status"), {
    companions: [
      "qc_record_id",
      "duration_ms",
      "pushed_by_staff_id",
      "pushed_at",
      "preview_channels",
      "offline_sent_at",
      "offline_sent_by_staff_id",
      "decided_at",
      "decided_by_user_id",
      "decide_client",
      "confirm_viewed_via",
      "viewed_ack_at",
      "viewed_ack_by_user_id",
    ],
    guards: guards([
      ["10:640", "sample.uploaded"],
      ["10:641", "sample.check_rejected"],
      ["10:642", "sample.qc_failed"],
      ["10:643", "sample.qc_passed"],
      ["10:644", "sample.pushed"],
      ["10:645", "sample.confirmed"],
      ["10:648", "sample.superseded"],
    ]),
    activity: (f) => ({
      category: "delivery",
      action: `delivery.sample.${f.event.split(".")[1]}`,
      summary: "样片版本处理",
    }),
  }),
];
