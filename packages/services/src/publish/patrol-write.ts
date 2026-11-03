import { Prisma } from "@liyoxi/db";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx, FiredTimer, RecurringRunContext } from "../kernel/index.js";
import { closeSystemFollowUps, createPatrolFollowUp } from "../staff/index.js";
import { timerKey } from "../timers/index.js";
import type { PatrolAbnormal, PatrolCheck, PatrolDeps } from "./patrol-context.js";
import { patrolChecked } from "./patrol-machine.js";
import { assertPatrolStaff, eligible, lockPatrolLaunch, patrolOf, weekOf } from "./patrol-repo.js";
import { taskOf } from "./repo.js";
import { checklist, files, invalid } from "./validate.js";

async function batchOf(tx: Tx, week: string, now: Date) {
  await tx.patrolBatch.createMany({
    data: { id: uuidv7(), weekStartDate: new Date(week), createdAt: now, updatedAt: now },
    skipDuplicates: true,
  });
  return tx.patrolBatch.findUniqueOrThrow({ where: { weekStartDate: new Date(week) } });
}
async function insertPatrol(
  tx: Tx,
  deps: PatrolDeps,
  ctx: IdentityContext,
  task: Awaited<ReturnType<typeof taskOf>>,
  batchId: string,
  source: string,
  now: Date,
  reason?: string,
) {
  const id = uuidv7();
  const result = await tx.patrolTask.createMany({
    data: {
      id,
      entityId: task.entityId,
      storeId: task.storeId,
      patrolBatchId: batchId,
      launchTaskId: task.id,
      deliveryTicketId: task.deliveryTicketId,
      orderItemId: task.orderItemId,
      source,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    },
    skipDuplicates: true,
  });
  if (!result.count) return null;
  await deps.flow.transition(tx, ctx, {
    machine: "patrol_task",
    stateField: "status",
    id,
    event: "patrol.create",
    ref: "11:542",
    created: true,
    args: patrolChecked(),
    entityId: task.entityId,
    storeId: task.storeId,
    ...(reason ? { note: reason } : {}),
    emit: {
      type: "patrol.created",
      payload: { v: 1, patrolTaskId: id, launchTaskId: task.id, orderItemId: task.orderItemId },
    },
  });
  return id;
}
export async function createManualPatrol(
  tx: Tx,
  deps: PatrolDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  input: { launchTaskId: string; reason?: string },
) {
  const task = await lockPatrolLaunch(tx, input.launchTaskId, staff);
  assertPatrolStaff(staff, task.deliveryTicket.publisherId);
  eligible(task, deps.clock.now());
  const open = await tx.patrolTask.findFirst({
    where: { launchTaskId: task.id, status: { in: ["pending", "abnormal"] } },
  });
  if (open) return { id: open.id, isNew: false };
  const now = deps.clock.now(),
    batch = await batchOf(tx, weekOf(now), now);
  const id = await insertPatrol(tx, deps, ctx, task, batch.id, "manual", now, input.reason);
  if (id) return { id, isNew: true };
  const winner = await tx.patrolTask.findFirstOrThrow({
    where: { launchTaskId: task.id, status: { in: ["pending", "abnormal"] } },
  });
  return { id: winner.id, isNew: false };
}
export async function generateWeeklyPatrol(tx: Tx, deps: PatrolDeps, scheduledFor: Date) {
  const now = deps.clock.now(),
    batch = await batchOf(tx, weekOf(scheduledFor), now);
  // Batch is outside the rank graph and is the single scheduler claim for this week.
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM patrol_batch WHERE id = ${batch.id}::uuid FOR NO KEY UPDATE`,
  );
  const current = await tx.patrolBatch.findUniqueOrThrow({ where: { id: batch.id } });
  if (current.generatedAt)
    return { liveTotal: current.liveTotal, sampledCount: current.sampledCount, generated: false };
  const all = await tx.launchTask.findMany({
    where: { isLive: true, orderItem: { phase: "live" }, deliveryTicket: { step: "in_service" } },
    include: {
      orderItem: true,
      deliveryTicket: true,
      patrolTasks: { where: { status: { in: ["pending", "abnormal"] } }, select: { id: true } },
    },
  });
  const reissues = await tx.deliveryReissue.findMany({
    where: {
      status: "published",
      closedAt: { gte: new Date(now.getTime() - 14 * 86400000), lte: now },
    },
    select: { deliveryTicketId: true },
  });
  const reissued = new Set(reissues.map((r) => r.deliveryTicketId));
  const candidates = all
    .filter((r) => !r.patrolTasks.length)
    .sort(
      (a, b) =>
        Number(reissued.has(b.deliveryTicketId)) - Number(reissued.has(a.deliveryTicketId)) ||
        Number(a.lastPatrolledAt !== null) - Number(b.lastPatrolledAt !== null) ||
        (a.lastPatrolledAt?.getTime() ?? 0) - (b.lastPatrolledAt?.getTime() ?? 0) ||
        Number(!!b.wentLiveAt && now.getTime() - b.wentLiveAt.getTime() < 7 * 86400000) -
          Number(!!a.wentLiveAt && now.getTime() - a.wentLiveAt.getTime() < 7 * 86400000) ||
        a.id.localeCompare(b.id),
    );
  const count = (await paramsAt(tx, ["patrol.weekly_sample"], now))[
    "patrol.weekly_sample"
  ] as number;
  const selected = candidates.slice(0, count);
  // Lock the complete selected parent graph before touching any patrol row.
  await lockRows(
    tx,
    "drama_order",
    [...new Set(selected.map((r) => r.orderItem.dramaOrderId))].sort(),
  );
  await lockRows(tx, "order_item", [...new Set(selected.map((r) => r.orderItemId))].sort());
  await lockRows(
    tx,
    "delivery_ticket",
    [...new Set(selected.map((r) => r.deliveryTicketId))].sort(),
  );
  await lockRows(tx, "launch_task", selected.map((r) => r.id).sort());
  const ctx = createIdentityContext({ actor: { type: "system", job: "patrol.weekly_generate" } });
  let sampledCount = 0;
  for (const selectedTask of selected) {
    const task = await taskOf(tx, selectedTask.id);
    try {
      eligible(task, now);
    } catch (error) {
      if (error instanceof AppError && error.error === "PATROL_NOT_ELIGIBLE") continue;
      throw error;
    }
    if (
      await insertPatrol(
        tx,
        deps,
        ctx,
        task,
        batch.id,
        reissued.has(task.deliveryTicketId) ? "reissue" : "weekly_sample",
        now,
      )
    )
      sampledCount++;
  }
  await tx.patrolBatch.update({
    where: { id: batch.id },
    data: { liveTotal: all.length, sampledCount, generatedAt: now, updatedAt: now },
  });
  return { liveTotal: all.length, sampledCount, generated: true };
}
async function abnormalChecklist(tx: Tx, body: PatrolAbnormal) {
  if (body.checklistVersionNo === undefined && body.results === undefined) return {};
  const template = await tx.checklistTemplate.findFirst({
    where: { code: "patrol.check", status: "active" },
  });
  if (!template || template.versionNo !== body.checklistVersionNo)
    throw new AppError("CHECKLIST_VERSION_STALE", {
      details: { code: "patrol.check", currentVersionNo: template?.versionNo ?? null },
    });
  const items = ChecklistItemsSchema.parse(template.items),
    rows = body.results ?? [];
  if (
    !rows.length ||
    new Set(rows.map((r) => r.key)).size !== rows.length ||
    rows.some((r) => {
      const item = items.find((i) => i.key === r.key);
      return (
        !item || (r.result === "na" && !item.allowNa) || (r.result === "fail" && !r.note?.trim())
      );
    })
  )
    throw invalid("results", "清单条目、结论或说明不合法");
  return {
    checklist_code: "patrol.check",
    checklist_version_no: template.versionNo,
    results: rows,
  };
}
export async function decidePatrol(
  tx: Tx,
  deps: PatrolDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  mode: "normal" | "abnormal" | "recover",
  body: PatrolCheck | PatrolAbnormal,
) {
  const initial = await patrolOf(tx, id, staff);
  const task = await lockPatrolLaunch(tx, initial.launchTaskId, staff);
  await lockRows(tx, "patrol_task", [id]);
  const row = await patrolOf(tx, id, staff),
    now = deps.clock.now();
  assertPatrolStaff(staff, row.deliveryTicket.publisherId);
  eligible(task, now);
  if (row.status !== (mode === "recover" ? "abnormal" : "pending"))
    throw new AppError("STATE_NOT_ALLOWED");
  if (
    !body.evidenceFileIds.length ||
    body.evidenceFileIds.length > 9 ||
    new Set(body.evidenceFileIds).size !== body.evidenceFileIds.length ||
    (mode === "recover" && body.evidenceFileIds.some((f) => row.evidenceFileIds.includes(f)))
  )
    throw invalid("evidenceFileIds", "须提交1–9张不重复的新截图");
  let values: Record<string, unknown>;
  if (mode === "abnormal") {
    const input = body as PatrolAbnormal;
    if (!input.note.trim() || input.note.length > 200) throw invalid("note", "说明须为1–200字");
    const kind = await tx.dictItem.findUnique({
      where: { dictTypeKey_code: { dictTypeKey: "patrol_issue", code: input.abnormalKindCode } },
    });
    if (!kind?.isEnabled)
      throw new AppError("DICT_ITEM_DISABLED", {
        details: { dictTypeKey: "patrol_issue", code: input.abnormalKindCode },
      });
    values = {
      ...(await abnormalChecklist(tx, input)),
      abnormal_kind_code: input.abnormalKindCode,
      note: input.note,
      found_at: now,
      notified_at: now,
    };
  } else {
    const check = await checklist(tx, "patrol.check", body.checklistVersionNo, body.results);
    values = {
      checklist_code: check!.code,
      checklist_version_no: check!.versionNo,
      results: check!.result,
      ...(mode === "recover" ? { recovered_at: now } : {}),
    };
  }
  await files(tx, body.evidenceFileIds, row, "evidence");
  for (const fileId of [...body.evidenceFileIds].sort())
    await deps.media.link(tx, {
      fileId,
      refType: "patrol_task",
      refId: id,
      role: "evidence",
      entityId: row.entityId,
      storeId: row.storeId,
    });
  await deps.flow.transition(tx, ctx, {
    machine: "patrol_task",
    stateField: "status",
    id,
    event:
      mode === "normal" ? "patrol.ok" : mode === "recover" ? "patrol.recover" : "patrol.abnormal",
    ref: mode === "normal" ? "11:543" : mode === "recover" ? "11:546" : "11:544",
    args: patrolChecked(),
    entityId: row.entityId,
    storeId: row.storeId,
    set: {
      ...values,
      evidence_file_ids:
        mode === "recover"
          ? [...row.evidenceFileIds, ...body.evidenceFileIds]
          : body.evidenceFileIds,
      checked_at: now,
      checked_by_staff_id: staff.staff.id,
    },
    emit: {
      type:
        mode === "normal"
          ? "patrol.passed"
          : mode === "recover"
            ? "patrol.recovered"
            : "patrol.abnormal",
      payload: {
        v: 1,
        patrolTaskId: id,
        launchTaskId: row.launchTaskId,
        ...(mode === "abnormal"
          ? {
              orderItemId: row.orderItemId,
              abnormalKindCode: (body as PatrolAbnormal).abnormalKindCode,
            }
          : {}),
      },
    },
  });
  await tx.launchTask.update({
    where: { id: row.launchTaskId },
    data: {
      lastPatrolledAt: now,
      lastPatrolResult: mode === "recover" ? "recovered" : mode,
      updatedAt: now,
    },
  });
  if (mode === "abnormal")
    await deps.timers.arm(tx, {
      kind: "patrol.followup",
      subject: { type: "patrol_task", id },
      key: timerKey("patrol.followup", { type: "patrol_task", id }),
      fireAt: new Date(now.getTime() + 3 * 86400000),
      entityId: row.entityId,
      storeId: row.storeId,
    });
  if (mode === "recover") {
    await deps.timers.cancel(tx, {
      subject: { type: "patrol_task", id },
      kinds: ["patrol.followup"],
    });
    await closeSystemFollowUps(tx, ctx, {
      subjects: [{ subjectType: "patrol_task", subjectId: id }],
      now,
      reason: "recovered",
    });
  }
}
export async function remindPatrol(
  tx: Tx,
  deps: PatrolDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
) {
  const first = await patrolOf(tx, id, staff);
  const task = await lockPatrolLaunch(tx, first.launchTaskId, staff);
  await lockRows(tx, "patrol_task", [id]);
  const row = await patrolOf(tx, id, staff),
    now = deps.clock.now();
  assertPatrolStaff(staff, row.deliveryTicket.publisherId);
  eligible(task, now);
  if (row.status !== "abnormal") throw new AppError("STATE_NOT_ALLOWED");
  const bizDate = calendarDate(now),
    logId = uuidv7();
  const made = await tx.manualReminderLog.createMany({
    data: {
      id: logId,
      subjectType: "patrol_task",
      subjectId: id,
      scene: "patrol_fix",
      bizDate: new Date(bizDate),
      sentByStaffId: staff.staff.id,
      createdAt: now,
    },
    skipDuplicates: true,
  });
  if (!made.count)
    throw new AppError("REMINDED_TODAY", {
      details: { scene: "patrol_fix", nextAvailableDate: addDays(bizDate, 1) },
    });
  await deps.flow.transition(tx, ctx, {
    machine: "patrol_task",
    stateField: "status",
    id,
    event: "patrol.remind",
    ref: "11:545",
    args: patrolChecked(),
    entityId: row.entityId,
    storeId: row.storeId,
    set: { remind_count: row.remindCount + 1 },
    emit: {
      type: "patrol.reminded",
      payload: { v: 1, patrolTaskId: id, remindCount: row.remindCount + 1 },
    },
  });
  await deps.events.emit(tx, ctx, {
    type: "manual_reminder.sent",
    aggregate: { type: "manual_reminder_log", id: logId },
    entityId: row.entityId,
    storeId: row.storeId,
    payload: {
      v: 1,
      manualReminderLogId: logId,
      subjectType: "patrol_task",
      subjectId: id,
      scene: "patrol_fix",
      bizDate,
    },
  });
}
export async function patrolFollowup(tx: Tx, deps: PatrolDeps, timer: FiredTimer) {
  if (timer.subjectType !== "patrol_task" || !timer.subjectId) return "skipped" as const;
  const first = await tx.patrolTask.findUnique({ where: { id: timer.subjectId } });
  if (!first) return "skipped" as const;
  const store = await tx.store.findUniqueOrThrow({ where: { id: first.storeId } });
  if (store.deliveryManagerId) await lockRows(tx, "staff", [store.deliveryManagerId]);
  await lockRows(tx, "store", [store.id]);
  const task = await lockPatrolLaunch(tx, first.launchTaskId);
  await lockRows(tx, "patrol_task", [first.id]);
  const row = await patrolOf(tx, first.id),
    now = deps.clock.now();
  if (
    row.status !== "abnormal" ||
    !task.isLive ||
    task.reviewStatus === "void" ||
    task.orderItem.phase !== "live" ||
    task.deliveryTicket.step !== "in_service" ||
    !task.orderItem.usageEndDate ||
    calendarDate(now) > task.orderItem.usageEndDate.toISOString().slice(0, 10)
  )
    return "skipped" as const;
  if (!row.foundAt || now.getTime() < row.foundAt.getTime() + 3 * 86400000)
    throw new AppError("STATE_NOT_ALLOWED");
  const currentStore = await tx.store.findUniqueOrThrow({ where: { id: row.storeId } });
  if (!currentStore.deliveryManagerId || currentStore.deliveryManagerId !== store.deliveryManagerId)
    throw new AppError("PRECONDITION_CHANGED");
  await createPatrolFollowUp(tx, deps.assembly, {
    patrolTaskId: row.id,
    ownerStaffId: currentStore.deliveryManagerId,
    now,
  });
  return "fired" as const;
}
export async function runWeeklyPatrol(deps: PatrolDeps, run: RecurringRunContext) {
  if (!run.tx) throw new TypeError("巡检周生成必须在原周期事务运行");
  return generateWeeklyPatrol(run.tx, deps, run.scheduledFor);
}
