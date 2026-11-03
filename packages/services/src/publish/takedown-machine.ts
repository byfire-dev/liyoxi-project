import { rowKey } from "../flow/index.js";
import type { TransitionFacts } from "../flow/index.js";
import type { Tx } from "../kernel/index.js";
import { takedownCalendarGuard } from "./takedown-calendar.js";
import { takedownTimerGuard } from "./takedown-overdue.js";
const authority = new WeakMap<Tx, { id: string; event: string }>();
export async function withTakedownWrite<T>(
  tx: Tx,
  id: string,
  event: string,
  write: () => Promise<T>,
) {
  if (authority.has(tx)) throw new TypeError("下架迁移不可嵌套");
  authority.set(tx, { id, event });
  try {
    return await write();
  } finally {
    authority.delete(tx);
  }
}
const authorized = async (tx: Tx, facts: TransitionFacts) => {
  const current = authority.get(tx);
  return current?.id === facts.subjectId && current.event === facts.event;
};
export const takedownCompanions = [
  "basis",
  "merchant_method",
  "merchant_confirmed_at",
  "merchant_confirmed_by_user_id",
  "check_due_at",
  "sla_snapshot",
  "still_online_count",
  "escalated_at",
  "breach_notice_count",
  "check_method",
  "checklist_code",
  "checklist_version_no",
  "results",
  "evidence_file_ids",
  "checked_by_staff_id",
  "checked_at",
];
export const takedownGuards = {
  ...Object.fromEntries(
    [
      ["11:654", "takedown.merchant_confirm"],
      ["11:655", "takedown.check_pass"],
      ["11:656", "takedown.sample_release"],
      ["11:657", "takedown.still_online"],
      ["11:658", "takedown.basis_reopen"],
      ["11:660", "takedown.breach_notice"],
    ].map(([ref, event]) => [rowKey(ref!, event!), authorized]),
  ),
  [rowKey("11:659", "takedown.escalate")]: async (tx: Tx, facts: TransitionFacts) =>
    (await authorized(tx, facts)) || (await takedownTimerGuard(tx, facts)),
  [rowKey("11:671", "sla.recalculated")]: takedownCalendarGuard,
};
