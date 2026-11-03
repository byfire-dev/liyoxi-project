import { randomInt } from "node:crypto";
import type {
  TakedownTaskCheckBody,
  TakedownTaskConfirmBody,
  TakedownTaskNoteBody,
} from "@liyoxi/contract";
import { addDays, atMinuteOfDay, calendarDate, endOfDay } from "@liyoxi/shared/time";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import { timerKey } from "../timers/index.js";
import type { PublishViewer } from "./context.js";
import type { TakedownDeps } from "./takedown-context.js";
import { launchChangedPort } from "./ports.js";
import { dateOf } from "./repo.js";
import {
  allowedMethods,
  assertTakedownStaff,
  expectedChecklist,
  takedownOf,
} from "./takedown-repo.js";
import type { TakedownRow } from "./takedown-repo.js";
import { checklist, files, invalid, owner } from "./validate.js";
import { withTakedownWrite } from "./takedown-machine.js";
export async function prelockTakedowns(
  tx: Tx,
  deps: TakedownDeps,
  rows: readonly TakedownRow[],
  staffId?: string,
  fileIds: readonly string[] = [],
) {
  const first = rows[0];
  if (!first) return;
  await deps.assembly.port(launchChangedPort)(tx, {
    orderItemId: first.orderItemId,
    deliveryTicketId: first.deliveryTicketId,
    phase: "prelock",
    deliveryTicketIds: [...new Set(rows.map((r) => r.deliveryTicketId))].sort(),
    takedownTaskIds: rows.map((r) => r.id).sort(),
    ...(staffId ? { staffId } : {}),
    fileIds: [...new Set(fileIds)].sort(),
  });
}
export async function evaluateTakedowns(tx: Tx, deps: TakedownDeps, rows: readonly TakedownRow[]) {
  const tickets = [...new Map(rows.map((r) => [r.deliveryTicketId, r])).values()].sort((a, b) =>
    a.deliveryTicketId.localeCompare(b.deliveryTicketId),
  );
  for (const row of tickets) {
    if (row.deliveryTicket.step === "terminated") continue;
    await deps.assembly.port(launchChangedPort)(tx, {
      orderItemId: row.orderItemId,
      deliveryTicketId: row.deliveryTicketId,
    });
  }
  return (
    await tx.deliveryTicket.findMany({
      where: {
        id: {
          in: tickets
            .filter((r) => r.deliveryTicket.step !== "archived")
            .map((r) => r.deliveryTicketId),
        },
        step: "archived",
      },
      select: { id: true },
      orderBy: { id: "asc" },
    })
  ).map((r) => r.id);
}
async function transition(
  tx: Tx,
  deps: TakedownDeps,
  ctx: IdentityContext,
  row: TakedownRow,
  event: string,
  ref: string,
  set: Record<string, unknown>,
  emitted: string,
  payload: Record<string, unknown> = {},
  note?: string,
  history: Record<string, unknown> = payload,
) {
  await withTakedownWrite(tx, row.id, event, () =>
    deps.flow.transition(tx, ctx, {
      machine: "takedown_task",
      stateField: "status",
      id: row.id,
      event,
      ref,
      entityId: row.entityId,
      storeId: row.storeId,
      set,
      payload: history,
      ...(note !== undefined ? { note } : {}),
      emit: {
        type: emitted,
        payload: { v: 1, takedownTaskId: row.id, orderItemId: row.orderItemId, ...payload },
      },
    }),
  );
}
const cancelOverdue = (tx: Tx, deps: TakedownDeps, id: string) =>
  deps.timers.cancel(tx, { subject: { type: "takedown_task", id }, kinds: ["takedown.overdue"] });
export async function confirmTakedown(
  tx: Tx,
  deps: TakedownDeps,
  viewer: PublishViewer,
  id: string,
  body: TakedownTaskConfirmBody,
) {
  owner(viewer);
  const first = await takedownOf(tx, id, viewer);
  await prelockTakedowns(tx, deps, [first]);
  const row = await takedownOf(tx, id, viewer),
    now = deps.clock.now();
  if (row.status !== "pending_merchant") throw new AppError("STATE_NOT_ALLOWED");
  if (!(allowedMethods(row) as readonly string[]).includes(body.method))
    throw new AppError("TAKEDOWN_METHOD_NOT_ALLOWED", {
      details: { allowedMethods: [...allowedMethods(row)] },
    });
  const snapshot = await paramsAt(tx, ["sla.takedown.check", "takedown.check_mode"], now);
  const policy = snapshot["sla.takedown.check"],
    mode = snapshot["takedown.check_mode"];
  const due = await deps.sla.dueAt(tx, {
    policy: "takedown.check",
    ...policy,
    from: new Date(Math.max(now.getTime(), endOfDay(dateOf(row.dueDate)!).getTime())),
    workHours: await workHoursAt(tx, now),
  });
  const draw = mode.mode === "sampled" ? (deps.sampleDraw?.() ?? randomInt(1, 10001)) : null;
  if (draw !== null && (!Number.isInteger(draw) || draw < 1 || draw > 10000))
    throw new TypeError("抽查签值必须在1–10000内");
  const sampled = mode.mode === "sampled" && draw! <= mode.sampleBp;
  const sampling = { checkMode: mode, draw, selectedForCheck: mode.mode === "evidence" || sampled };
  await transition(
    tx,
    deps,
    viewer.ctx,
    row,
    "takedown.merchant_confirm",
    "11:654",
    {
      merchant_method: body.method,
      merchant_confirmed_at: now,
      merchant_confirmed_by_user_id: viewer.ctx.actor.id,
      check_due_at: due.dueAt,
      sla_snapshot: { ...due.snapshot },
    },
    "takedown.merchant_confirmed",
    { merchantMethod: body.method },
    undefined,
    { merchantMethod: body.method, ...sampling },
  );
  await cancelOverdue(tx, deps, row.id);
  if (mode.mode === "sampled" && !sampled)
    await transition(
      tx,
      deps,
      createIdentityContext({
        actor: { type: "system", job: "takedown.sample_release" },
        requestId: viewer.ctx.requestId,
      }),
      row,
      "takedown.sample_release",
      "11:656",
      { check_method: "sampled_out", checked_at: now },
      "takedown.checked",
      { checkMethod: "sampled_out" },
      undefined,
      { checkMethod: "sampled_out", ...sampling },
    );
  await evaluateTakedowns(tx, deps, [row]);
}
export async function validateTakedownCheck(
  tx: Tx,
  row: TakedownRow,
  staff: StaffContext,
  body: TakedownTaskCheckBody,
) {
  assertTakedownStaff(staff, row);
  if (!["pending_merchant", "merchant_confirmed"].includes(row.status))
    throw new AppError("STATE_NOT_ALLOWED");
  const expectedChecklistCode = expectedChecklist(row);
  if (body.checklistCode !== expectedChecklistCode)
    throw new AppError("PRECONDITION_CHANGED", { details: { expectedChecklistCode } });
  if (
    body.evidenceFileIds.length < 2 ||
    body.evidenceFileIds.length > 9 ||
    new Set(body.evidenceFileIds).size !== body.evidenceFileIds.length
  )
    throw invalid("evidenceFileIds", "须提交2–9张不同证据截图");
  const checked = await checklist(tx, body.checklistCode, body.checklistVersionNo, body.results);
  await files(tx, body.evidenceFileIds, row, "evidence");
  return checked!;
}
export async function applyTakedownCheck(
  tx: Tx,
  deps: TakedownDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  row: TakedownRow,
  body: TakedownTaskCheckBody,
) {
  for (const fileId of [...body.evidenceFileIds].sort())
    await deps.media.link(tx, {
      fileId,
      refType: "takedown_task",
      refId: row.id,
      role: "evidence",
      entityId: row.entityId,
      storeId: row.storeId,
    });
  await transition(
    tx,
    deps,
    ctx,
    row,
    "takedown.check_pass",
    "11:655",
    {
      check_method: "evidence",
      checklist_code: body.checklistCode,
      checklist_version_no: body.checklistVersionNo,
      results: body.results,
      evidence_file_ids: body.evidenceFileIds,
      checked_by_staff_id: staff.staff.id,
      checked_at: deps.clock.now(),
    },
    "takedown.checked",
    { checkMethod: "evidence" },
  );
  await cancelOverdue(tx, deps, row.id);
}
export async function adminTakedownAction(
  tx: Tx,
  deps: TakedownDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  action: "markOnline" | "escalate" | "sendBreachNotice",
  body: TakedownTaskNoteBody = {},
) {
  const first = await takedownOf(tx, id, staff);
  await prelockTakedowns(tx, deps, [first], staff.staff.id);
  const row = await takedownOf(tx, id, staff),
    now = deps.clock.now();
  assertTakedownStaff(staff, row, action === "sendBreachNotice");
  if (body.note !== undefined && body.note.length > 200) throw invalid("note", "说明最多200字");
  if (row.status !== (action === "markOnline" ? "merchant_confirmed" : "pending_merchant"))
    throw new AppError("STATE_NOT_ALLOWED");
  if (action === "markOnline") {
    await transition(
      tx,
      deps,
      ctx,
      row,
      "takedown.still_online",
      "11:657",
      {
        merchant_method: null,
        merchant_confirmed_at: null,
        merchant_confirmed_by_user_id: null,
        check_due_at: null,
        sla_snapshot: null,
        still_online_count: row.stillOnlineCount + 1,
        escalated_at: now,
      },
      "takedown.found_online",
      { stillOnlineCount: row.stillOnlineCount + 1 },
      body.note,
    );
    const due = dateOf(row.dueDate)!,
      fireAt = atMinuteOfDay(addDays(due, 1), 540);
    await cancelOverdue(tx, deps, row.id);
    if (fireAt > now)
      await deps.timers.arm(tx, {
        kind: "takedown.overdue",
        subject: { type: "takedown_task", id },
        key: timerKey("takedown.overdue", { type: "takedown_task", id }, due),
        fireAt,
        entityId: row.entityId,
        storeId: row.storeId,
        payload: { dueDate: due },
      });
    return;
  }
  if (calendarDate(now) <= dateOf(row.dueDate)!)
    throw new AppError("TAKEDOWN_NOT_OVERDUE", { details: { dueDate: dateOf(row.dueDate) } });
  if (action === "escalate") {
    await transition(
      tx,
      deps,
      ctx,
      row,
      "takedown.escalate",
      "11:659",
      { escalated_at: now },
      "takedown.escalated",
      { dueDate: dateOf(row.dueDate) },
      body.note,
      { source: "staff" },
    );
    return;
  }
  const bizDate = calendarDate(now),
    logId = uuidv7();
  const made = await tx.manualReminderLog.createMany({
    data: {
      id: logId,
      subjectType: "takedown_task",
      subjectId: id,
      scene: "breach",
      bizDate: new Date(bizDate),
      sentByStaffId: staff.staff.id,
      createdAt: now,
    },
    skipDuplicates: true,
  });
  if (!made.count)
    throw new AppError("REMINDED_TODAY", {
      details: { scene: "breach", nextAvailableDate: addDays(bizDate, 1) },
    });
  await withTakedownWrite(tx, id, "takedown.breach_notice", () =>
    deps.flow.transition(tx, ctx, {
      machine: "takedown_task",
      stateField: "status",
      id,
      event: "takedown.breach_notice",
      ref: "11:660",
      entityId: row.entityId,
      storeId: row.storeId,
      set: { breach_notice_count: row.breachNoticeCount + 1 },
      emit: {
        type: "takedown.breach_notified",
        payload: { v: 1, takedownTaskId: id, breachNoticeCount: row.breachNoticeCount + 1 },
      },
    }),
  );
  await deps.events.emit(tx, ctx, {
    type: "manual_reminder.sent",
    aggregate: { type: "manual_reminder_log", id: logId },
    entityId: row.entityId,
    storeId: row.storeId,
    payload: {
      v: 1,
      manualReminderLogId: logId,
      subjectType: "takedown_task",
      subjectId: id,
      scene: "breach",
      bizDate,
    },
  });
}
