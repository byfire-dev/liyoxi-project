import type { TakedownTaskDetail } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
import { actorName } from "./repo.js";
import type { TakedownRow } from "./takedown-repo.js";
const kinds: Record<string, TakedownTaskDetail["timeline"][number]["kind"]> = {
  "takedown.create": "created",
  "takedown.merchant_confirm": "merchant_confirmed",
  "takedown.sample_release": "sample_released",
  "takedown.still_online": "found_online",
  "takedown.basis_reopen": "basis_reopened",
  "takedown.escalate": "escalated",
  "takedown.breach_notice": "breach_notified",
  "takedown.check_pass": "checked",
  "takedown.void": "voided",
  "sla.recalculated": "check_due_recalculated",
};
export async function takedownTimeline(tx: Tx, row: TakedownRow) {
  const items: TakedownTaskDetail["timeline"] = [];
  const history = await tx.statusTransition.findMany({
    where: { machine: "takedown_task", stateField: "status", subjectId: row.id },
    orderBy: { seq: "asc" },
  });
  for (const h of history) {
    const kind = kinds[h.event];
    if (!kind) continue;
    items.push({
      at: h.occurredAt.toISOString(),
      kind,
      actorType:
        h.actorType === "merchant" ? "merchant" : h.actorType === "staff" ? "staff" : "system",
      actorName: await actorName(tx, h.actorType, h.actorId, row.entityId),
      node: null,
      note: h.note,
    });
  }
  const notifications = await tx.notification.findMany({
    where: {
      notifySceneKey: "m.offline_remind",
      bizType: "store",
      bizId: row.storeId,
      entityId: row.entityId,
      storeId: row.storeId,
      dedupeKey: {
        startsWith: `offline:${row.storeId}:${row.usageEndDate.toISOString().slice(0, 10)}:`,
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const nodes = new Set<string>();
  for (const n of notifications) {
    if (nodes.has(n.node) || !["T-30", "T-7", "T-1", "T-0"].includes(n.node)) continue;
    nodes.add(n.node);
    items.push({
      at: n.createdAt.toISOString(),
      kind: "auto_reminded",
      actorType: "system",
      actorName: null,
      node: n.node,
      note: null,
    });
  }
  const reminders = await tx.manualReminderLog.findMany({
    where: { subjectType: "takedown_task", subjectId: row.id, scene: "takedown" },
    orderBy: { createdAt: "asc" },
  });
  for (const r of reminders)
    items.push({
      at: r.createdAt.toISOString(),
      kind: "manual_reminded",
      actorType: "staff",
      actorName: await actorName(tx, "staff", r.sentByStaffId, row.entityId),
      node: null,
      note: null,
    });
  const follows = await tx.followUp.findMany({
    where: {
      subjectType: "takedown_task",
      subjectId: row.id,
      entityId: row.entityId,
      storeId: row.storeId,
      actorType: { in: ["staff", "merchant"] },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const f of follows)
    items.push({
      at: f.createdAt.toISOString(),
      kind: "follow_up",
      actorType: f.actorType === "staff" ? "staff" : "merchant",
      actorName: await actorName(tx, f.actorType, f.actorId, row.entityId),
      node: null,
      note: f.content,
    });
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
