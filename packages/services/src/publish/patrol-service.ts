import type { StaffContext } from "../authz/index.js";
import type { IdentityContext, Tx, FiredTimer, RecurringRunContext } from "../kernel/index.js";
import type { PublishWriteOptions } from "./context.js";
import type {
  PatrolAbnormal,
  PatrolCheck,
  PatrolDeps,
  PatrolFilter,
  PatrolPage,
} from "./patrol-context.js";
import { listPatrols, patrolDetail, patrolSummary } from "./patrol-read.js";
import {
  createManualPatrol,
  decidePatrol,
  patrolFollowup,
  remindPatrol,
  runWeeklyPatrol,
} from "./patrol-write.js";
import { repairPatrols, repairPatrolTimers } from "./patrol-invariants.js";
export function createPublishPatrol(deps: PatrolDeps) {
  return {
    list: (staff: StaffContext, query: PatrolPage) =>
      deps.tx.run((tx) => listPatrols(tx, deps, staff, query)),
    summary: (staff: StaffContext, query: PatrolFilter = {}) =>
      deps.tx.run((tx) => patrolSummary(tx, deps, staff, query)),
    get: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => patrolDetail(tx, deps, staff, id)),
    create: (
      ctx: IdentityContext,
      staff: StaffContext,
      input: { launchTaskId: string; reason?: string },
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        const created = await createManualPatrol(tx, deps, ctx, staff, input);
        return {
          isNew: created.isNew,
          patrolTask: await patrolDetail(tx, deps, staff, created.id),
        };
      }, options),
    decide: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      mode: "normal" | "abnormal" | "recover",
      body: PatrolCheck | PatrolAbnormal,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        await decidePatrol(tx, deps, ctx, staff, id, mode, body);
        return patrolDetail(tx, deps, staff, id);
      }, options),
    remind: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        await remindPatrol(tx, deps, ctx, staff, id);
        return patrolDetail(tx, deps, staff, id);
      }, options),
    followup: (tx: Tx, timer: FiredTimer) => patrolFollowup(tx, deps, timer),
    weekly: (run: RecurringRunContext) => runWeeklyPatrol(deps, run),
    reconcile: (tx: Tx, now: Date) => repairPatrols(tx, deps, now),
    reconcileTimers: (tx: Tx, now: Date) => repairPatrolTimers(tx, deps, now),
  };
}
export type PublishPatrol = ReturnType<typeof createPublishPatrol>;
