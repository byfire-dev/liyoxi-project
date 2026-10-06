import { chainKey, machinePort, rowKey } from "../flow/index.js";
import type { MachineBinding, TransitionFacts } from "../flow/index.js";
import { implementKeyed, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
const pass = Symbol("delivery.checked");
export const checked = () => pass;
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
  ["10:180", "episodes.all_passed"],
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
  ],
  guards: guards(rows.filter(([ref]) => ref !== "10:196")),
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
];
