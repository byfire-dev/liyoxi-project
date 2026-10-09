import type { OpenWorkSummary } from "@liyoxi/contract";
import type { ASSIGNMENT_HISTORY_REASON_CODE } from "@liyoxi/contract/enums";
import type { Staff } from "@liyoxi/db";
import { assertConfirm } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, LOCK_ORDER, lockRows, uuidv7, actorColumns } from "../kernel/index.js";
import type { IdentityContext, StaffWorkItem, StaffWorkSources, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import { assignmentContactTimerKey } from "./sla.js";
import type { StaffManagementDeps } from "./management.js";
import { staffBriefOf } from "./me.js";

export function workSources(deps: Pick<StaffManagementDeps, "workSources">): StaffWorkSources {
  if (!deps.workSources) throw new AppError("INTERNAL", { message: "员工在办来源尚未装配" });
  return deps.workSources;
}
export function workCounts(items: readonly StaffWorkItem[]) {
  const groups = new Map<
    string,
    {
      source: StaffWorkItem["source"];
      subjectType: StaffWorkItem["subjectType"];
      count: number;
      samples: { subjectId: string; label: string }[];
    }
  >();
  for (const item of items) {
    const key = `${item.source}:${item.subjectType}`;
    const g = groups.get(key) ?? {
      source: item.source,
      subjectType: item.subjectType,
      count: 0,
      samples: [],
    };
    g.count++;
    if (g.samples.length < 5) g.samples.push({ subjectId: item.subjectId, label: item.label });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) =>
    `${a.source}:${a.subjectType}`.localeCompare(`${b.source}:${b.subjectType}`),
  );
}
export async function openWork(
  tx: Tx,
  deps: StaffManagementDeps,
  row: Staff,
): Promise<OpenWorkSummary> {
  const items = await workSources(deps).read(tx, { staffId: row.id, now: deps.clock.now() });
  const candidates = await tx.staff.findMany({
    where: { status: "active", staffRoleKey: row.staffRoleKey, id: { not: row.id } },
    orderBy: { staffNo: "asc" },
  });
  return {
    staff: staffBriefOf(row),
    total: items.length,
    bySource: workCounts(items),
    candidates: candidates.map(staffBriefOf),
    pendingApprovalsAsRequester: await tx.approvalRequest.count({
      where: { requesterStaffId: row.id, status: "pending" },
    }),
  };
}
export async function transferWork(
  tx: Tx,
  deps: StaffManagementDeps,
  ctx: IdentityContext,
  input: {
    from: Staff;
    to: Staff;
    reason: (typeof ASSIGNMENT_HISTORY_REASON_CODE.values)[number];
    note?: string;
    confirm?: { staffNo: number; openWorkCount: number };
  },
) {
  const now = deps.clock.now();
  const sources = workSources(deps);
  const before = await sources.read(tx, { staffId: input.from.id, now });
  if (input.confirm)
    assertConfirm(input.confirm, { staffNo: input.from.staffNo, openWorkCount: before.length });
  const byTable = new Map<keyof typeof LOCK_ORDER, string[]>();
  for (const item of before)
    for (const ref of item.locks) {
      const ids = byTable.get(ref.table) ?? [];
      ids.push(ref.id);
      byTable.set(ref.table, ids);
    }
  for (const [table, ids] of [...byTable].sort(([a], [b]) => LOCK_ORDER[a] - LOCK_ORDER[b])) {
    if (table === "assignment_cursor") throw new TypeError("业务来源不能返回游标锁");
    await lockRows(tx, table, ids);
  }
  const current = await sources.read(tx, { staffId: input.from.id, now });
  const keys = new Set(before.map((r) => `${r.source}:${r.subjectType}:${r.subjectId}`));
  if (current.some((r) => !keys.has(`${r.source}:${r.subjectType}:${r.subjectId}`)))
    throw new AppError("BUSY");
  if (input.confirm)
    assertConfirm(input.confirm, { staffNo: input.from.staffNo, openWorkCount: current.length });
  const moved = await sources.reassign(tx, {
    fromStaffId: input.from.id,
    toStaffId: input.to.id,
    items: current,
    ctx,
    now,
  });
  if (moved.length !== current.length)
    throw new AppError("BUSY", { message: "在办归属已改变，请重试" });
  if (!moved.length) return { batchId: null, moved: [] };
  const batchId = uuidv7();
  let aggregateId: string | null = null;
  const countsBySource: Partial<Record<StaffWorkItem["source"], number>> = {};
  for (const item of moved) {
    let contactDueAt: Date | null = null;
    let slaSnapshot;
    if (item.source === "store_manager" && item.subjectType === "store") {
      if (!deps.sla || !deps.timers)
        throw new AppError("INTERNAL", { message: "员工联系时限尚未装配" });
      const prior = await tx.assignmentHistory.findMany({
        where: {
          source: "store_manager",
          subjectType: "store",
          subjectId: item.subjectId,
          contactedAt: null,
          contactVoidedAt: null,
        },
        orderBy: { id: "asc" },
      });
      for (const old of prior) {
        await tx.assignmentHistory.update({
          where: { id: old.id },
          data: { contactVoidedAt: now, updatedAt: now },
        });
        await deps.timers.cancel(tx, {
          subject: { type: "assignment_history", id: old.id },
          kinds: ["sla.breach"],
        });
      }
      const values = await paramsAt(tx, ["sla.manager.first_contact"], now);
      const due = await deps.sla.dueAt(tx, {
        policy: "manager.first_contact",
        ...values["sla.manager.first_contact"],
        from: now,
        workHours: await workHoursAt(tx, now),
      });
      contactDueAt = due.dueAt;
      slaSnapshot = due.snapshot;
    }
    const history = await tx.assignmentHistory.create({
      data: {
        id: uuidv7(),
        batchId,
        source: item.source,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        fromStaffId: input.from.id,
        toStaffId: input.to.id,
        reasonCode: input.reason,
        note: input.note ?? null,
        ...actorColumns(ctx.actor),
        contactDueAt,
        ...(slaSnapshot ? { slaSnapshot: { ...slaSnapshot } } : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
    aggregateId ??= history.id;
    countsBySource[item.source] = (countsBySource[item.source] ?? 0) + 1;
    if (contactDueAt)
      await deps.timers!.arm(tx, {
        kind: "sla.breach",
        subject: { type: "assignment_history", id: history.id },
        fireAt: contactDueAt,
        key: assignmentContactTimerKey(history.id),
        payload: { dueAt: contactDueAt.toISOString() },
        entityId: item.entityId,
        ...(item.storeId ? { storeId: item.storeId } : {}),
      });
  }
  if (!deps.events) throw new AppError("INTERNAL", { message: "员工事件尚未装配" });
  await deps.events.emit(tx, ctx, {
    type: "assignment.transferred",
    aggregate: { type: "assignment_history", id: aggregateId! },
    dedupeKey: `assignment.transferred:${batchId}`,
    payload: { v: 1, batchId, countsBySource, toStaffId: input.to.id, reasonCode: input.reason },
  });
  return {
    batchId,
    moved: workCounts(moved).map(({ source, subjectType, count }) => ({
      source,
      subjectType,
      count,
    })),
  };
}
