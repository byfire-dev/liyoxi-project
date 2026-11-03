import { rowKey } from "../flow/index.js";
import type { TransitionFacts } from "../flow/index.js";
import type { Tx } from "../kernel/index.js";
const pass = Symbol("publish.patrol.checked");
export const patrolChecked = () => pass;
export const patrolCompanions = [
  "checklist_code",
  "checklist_version_no",
  "results",
  "abnormal_kind_code",
  "note",
  "evidence_file_ids",
  "checked_at",
  "checked_by_staff_id",
  "found_at",
  "notified_at",
  "recovered_at",
  "remind_count",
];
export const patrolGuards = Object.fromEntries(
  [
    ["11:542", "patrol.create"],
    ["11:543", "patrol.ok"],
    ["11:544", "patrol.abnormal"],
    ["11:545", "patrol.remind"],
    ["11:546", "patrol.recover"],
  ].map(([ref, event]) => [
    rowKey(ref!, event!),
    async (_tx: Tx, facts: TransitionFacts) => facts.args === pass,
  ]),
);
