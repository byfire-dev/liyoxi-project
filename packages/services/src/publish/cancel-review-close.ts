import type { Approval, ApprovalDecision, ApprovalRow } from "../approval/index.js";
import { record } from "../audit/index.js";
import type { Flow, TransitionFacts } from "../flow/index.js";
import { chainKey, machinePort, rowKey } from "../flow/index.js";
import { addDays, atMinuteOfDay, calendarDate, endOfDay } from "@liyoxi/shared/time";
import { AppError, createIdentityContext, implementKeyed, uuidv7 } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, Tx } from "../kernel/index.js";
import { SLA_UNITS, workHoursAt } from "../sla/index.js";
import type { Sla } from "../sla/index.js";
import { closeSystemFollowUps } from "../staff/index.js";
import { createTimers, timerKey } from "../timers/index.js";

const ids = (values: readonly string[]) => [...new Set(values)].sort();
const pass = Symbol("publish.cancel_close");
const active = new WeakMap<Tx, { requestId: string; itemIds: readonly string[] }>();
const withdrawing = new WeakMap<Tx, string>();
export const cancelPublishGuard = async (tx: Tx, facts: TransitionFacts) => {
  const call = active.get(tx);
  if (facts.args !== pass || !call) return false;
  const request = await tx.cancelRequest.findUnique({ where: { id: call.requestId } });
  return request?.status === "pending_execution" && request.closedAt === null;
};

/** Only the cancellation owner can authorize a launch-link system withdrawal. */
export async function closeCancelReviewLaunchSubmission(
  tx: Tx,
  row: ApprovalRow,
  decision: ApprovalDecision,
) {
  const call = active.get(tx),
    submissionId = withdrawing.get(tx);
  if (!call || !submissionId || !decision.isDecidedBySystem || row.kind !== "launch_link")
    throw new AppError("STATE_NOT_ALLOWED");
  const sub = await tx.launchSubmission.findUnique({
    where: { id: submissionId },
    include: { launchTask: true },
  });
  if (
    !sub ||
    sub.approvalRequestId !== row.id ||
    sub.result !== "pending" ||
    sub.entityId !== row.entityId ||
    sub.storeId !== row.storeId ||
    !call.itemIds.includes(sub.launchTask.orderItemId)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  await tx.launchSubmission.update({
    where: { id: sub.id },
    data: { result: "withdrawn", updatedAt: decision.decidedAt },
  });
}

export async function readCancelReviewPublishTargets(tx: Tx, orderItemIds: readonly string[]) {
  const items = await tx.orderItem.findMany({
    where: { id: { in: [...orderItemIds] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      usageEndDate: true,
      orderItemAccounts: {
        orderBy: { channelAccountId: "asc" },
        select: { channelAccountId: true },
      },
    },
  });
  const tasks = await tx.launchTask.findMany({
    where: { orderItemId: { in: [...orderItemIds] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      entityId: true,
      storeId: true,
      orderItemId: true,
      deliveryTicketId: true,
      channelAccountId: true,
      isLive: true,
      reviewStatus: true,
      launchSubmissions: {
        where: { result: "pending" },
        orderBy: { id: "asc" },
        select: { id: true, approvalRequestId: true },
      },
    },
  });
  const patrols = await tx.patrolTask.findMany({
    where: { orderItemId: { in: [...orderItemIds] }, status: { in: ["pending", "abnormal"] } },
    orderBy: { id: "asc" },
    select: { id: true, entityId: true, storeId: true, orderItemId: true, launchTaskId: true },
  });
  const takedowns = await tx.takedownTask.findMany({
    where: { orderItemId: { in: [...orderItemIds] }, status: { not: "void" } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      orderItemId: true,
      channelAccountId: true,
      launchTaskId: true,
      status: true,
      triggerKind: true,
      usageEndDate: true,
      dueDate: true,
      checkDueAt: true,
      merchantConfirmedAt: true,
      slaSnapshot: true,
    },
  });
  return {
    orderItemIds: ids(orderItemIds),
    items,
    tasks,
    patrols,
    takedowns,
    approvalRequestIds: ids(
      tasks.flatMap((t) => t.launchSubmissions.map((s) => s.approvalRequestId)),
    ),
    channelAccountIds: ids([
      ...tasks.map((t) => t.channelAccountId),
      ...items.flatMap((i) => i.orderItemAccounts.map((a) => a.channelAccountId)),
    ]),
    launchTaskIds: tasks.map((t) => t.id),
    patrolTaskIds: patrols.map((p) => p.id),
    takedownTaskIds: takedowns.map((t) => t.id),
  };
}
export type CancelReviewPublishTargets = Awaited<ReturnType<typeof readCancelReviewPublishTargets>>;
interface CloseDeps {
  readonly assembly: Assembly;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly approval: Pick<Approval, "withdraw">;
  readonly sla: Sla;
}
interface CloseInput {
  readonly cancelRequestId: string;
  readonly approvalRequestId: string;
  readonly now: Date;
  readonly lines: readonly {
    readonly orderItemId: string;
    readonly stage: string;
    readonly terminationDate: Date | null;
  }[];
}

/** Implements only the 10:191/192 same-Tx close, not M6 publishing or takedown operations. */
export async function closeCancelReviewPublish(
  tx: Tx,
  deps: CloseDeps,
  ctx: IdentityContext,
  targets: CancelReviewPublishTargets,
  input: CloseInput,
) {
  if (active.has(tx)) throw new AppError("INTERNAL");
  if (
    JSON.stringify(targets) !==
    JSON.stringify(await readCancelReviewPublishTargets(tx, targets.orderItemIds))
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消发布锁图已变化" });
  active.set(tx, { requestId: input.cancelRequestId, itemIds: targets.orderItemIds });
  const system = createIdentityContext({
    actor: { type: "system", job: "order.execute_cancel" },
    requestId: ctx.requestId,
  });
  const timers = createTimers({ assembly: deps.assembly });
  try {
    for (const task of targets.tasks) {
      if (task.reviewStatus === "void" || (task.isLive && task.reviewStatus === "passed")) continue;
      for (const sub of task.launchSubmissions) {
        withdrawing.set(tx, sub.id);
        try {
          await deps.approval.withdraw(tx, system, {
            approvalId: sub.approvalRequestId,
            note: "订单项取消执行，撤回在途上线核验",
          });
        } finally {
          withdrawing.delete(tx);
        }
      }
      await deps.flow.transition(tx, ctx, {
        machine: "launch_task",
        stateField: "review_status",
        id: task.id,
        event: task.isLive ? "launch.settle" : "launch.void",
        ref: task.isLive ? "11:305" : "11:304",
        args: pass,
        entityId: task.entityId,
        storeId: task.storeId,
        ...(task.isLive ? {} : { set: { void_reason: "terminated" } }),
        payload: { cancelRequestId: input.cancelRequestId },
        emit: task.isLive
          ? {
              type: "launch.settled",
              payload: { v: 1, launchTaskId: task.id, orderItemId: task.orderItemId },
            }
          : {
              type: "launch.voided",
              payload: {
                v: 1,
                launchTaskId: task.id,
                orderItemId: task.orderItemId,
                voidReason: "terminated",
              },
            },
      });
    }
    for (const patrol of targets.patrols) {
      await deps.flow.transition(tx, ctx, {
        machine: "patrol_task",
        stateField: "status",
        id: patrol.id,
        event: "patrol.void",
        ref: "11:547",
        args: pass,
        entityId: patrol.entityId,
        storeId: patrol.storeId,
        payload: { cancelRequestId: input.cancelRequestId },
        emit: {
          type: "patrol.voided",
          payload: { v: 1, patrolTaskId: patrol.id },
        },
      });
      await timers.cancel(tx, {
        subject: { type: "patrol_task", id: patrol.id },
        kinds: ["patrol.followup"],
      });
    }
    await closeSystemFollowUps(tx, ctx, {
      subjects: targets.patrols.map((p) => ({
        subjectType: "patrol_task" as const,
        subjectId: p.id,
      })),
      now: input.now,
    });
    for (const item of targets.items) {
      const line = input.lines.find((l) => l.orderItemId === item.id);
      if (!line) throw new AppError("PRECONDITION_CHANGED");
      const delivered = await tx.deliveryRelease.count({ where: { orderItemId: item.id } });
      if (!delivered) continue;
      const usageEndDate = line.terminationDate ?? item.usageEndDate;
      if (!usageEndDate) throw new AppError("PRECONDITION_CHANGED");
      const due = addDays(calendarDate(input.now), 1),
        dueDate = new Date(`${due}T00:00:00.000Z`);
      const accountIds = ids([
        ...item.orderItemAccounts.map((a) => a.channelAccountId),
        ...targets.takedowns
          .filter((t) => t.orderItemId === item.id)
          .map((t) => t.channelAccountId),
      ]);
      for (const channelAccountId of accountIds) {
        const launch = targets.tasks.find(
          (t) => t.orderItemId === item.id && t.channelAccountId === channelAccountId,
        );
        if (!launch)
          throw new AppError("PRECONDITION_CHANGED", { message: "已交付账号缺少真实上线任务" });
        const old = targets.takedowns.find(
          (t) => t.orderItemId === item.id && t.channelAccountId === channelAccountId,
        );
        if (old?.status === "checked") continue;
        const base = {
          triggerKind: line.stage === "live" ? "platform_termination" : "terminated_after_delivery",
          usageEndDate,
          dueDate,
        } as const;
        let id: string;
        if (old) {
          id = old.id;
          let checkDueAt: Date | undefined, slaSnapshot;
          if (old.status === "merchant_confirmed") {
            const snapshot = old.slaSnapshot as {
              policy?: string;
              amount?: number;
              unit?: string;
            } | null;
            if (
              !old.merchantConfirmedAt ||
              !snapshot ||
              typeof snapshot.policy !== "string" ||
              typeof snapshot.amount !== "number" ||
              !SLA_UNITS.includes(snapshot.unit as (typeof SLA_UNITS)[number])
            )
              throw new AppError("INTERNAL", { message: "下架核查时限快照不合法" });
            const result = await deps.sla.dueAt(tx, {
              policy: snapshot.policy,
              amount: snapshot.amount,
              unit: snapshot.unit as (typeof SLA_UNITS)[number],
              from: new Date(Math.max(old.merchantConfirmedAt.getTime(), endOfDay(due).getTime())),
              workHours: await workHoursAt(tx, input.now),
            });
            checkDueAt = result.dueAt;
            slaSnapshot = result.snapshot;
          }
          await tx.takedownTask.update({
            where: { id },
            data: {
              ...base,
              ...(checkDueAt ? { checkDueAt, slaSnapshot: { ...slaSnapshot } } : {}),
              updatedAt: input.now,
            },
          });
          await record(
            tx,
            ctx.actor,
            {
              requestId: ctx.requestId,
              ip: ctx.ip,
              userAgent: ctx.userAgent,
              sessionId: null,
              authMethod: null,
            },
            {
              stream: "activity",
              category: "delivery",
              action: "publish.takedown_task.cancel_resync",
              summary: "取消执行同步下架时限",
              target: { type: "takedown_task", id },
              entityId: launch.entityId,
              storeId: launch.storeId,
              before: {
                status: old.status,
                triggerKind: old.triggerKind,
                usageEndDate: old.usageEndDate.toISOString().slice(0, 10),
                dueDate: old.dueDate.toISOString().slice(0, 10),
                checkDueAt: old.checkDueAt?.toISOString() ?? null,
              },
              after: {
                status: old.status,
                triggerKind: base.triggerKind,
                usageEndDate: usageEndDate.toISOString().slice(0, 10),
                dueDate: due,
                checkDueAt: (checkDueAt ?? old.checkDueAt)?.toISOString() ?? null,
              },
              fields: [
                "triggerKind",
                "usageEndDate",
                "dueDate",
                ...(checkDueAt ? ["checkDueAt"] : []),
              ],
            },
          );
        } else {
          id = uuidv7();
          await tx.takedownTask.create({
            data: {
              id,
              entityId: launch.entityId,
              storeId: launch.storeId,
              orderItemId: item.id,
              deliveryTicketId: launch.deliveryTicketId,
              launchTaskId: launch.id,
              channelAccountId,
              ...base,
              basis: launch.isLive ? "live" : "delivered_unverified",
              status: "pending_merchant",
              createdAt: input.now,
              updatedAt: input.now,
            },
          });
          await deps.flow.transition(tx, ctx, {
            machine: "takedown_task",
            stateField: "status",
            id,
            event: "takedown.create",
            ref: "11:653",
            created: true,
            args: pass,
            entityId: launch.entityId,
            storeId: launch.storeId,
            emit: {
              type: "takedown.created",
              payload: {
                v: 1,
                takedownTaskId: id,
                orderItemId: item.id,
                channelAccountId,
                dueDate: due,
                basis: launch.isLive ? "live" : "delivered_unverified",
                triggerKind: base.triggerKind,
                node: "created",
              },
            },
          });
        }
        await timers.cancel(tx, {
          subject: { type: "takedown_task", id },
          kinds: ["takedown.overdue"],
        });
        if (!old || old.status === "pending_merchant")
          await timers.arm(tx, {
            kind: "takedown.overdue",
            subject: { type: "takedown_task", id },
            key: timerKey("takedown.overdue", { type: "takedown_task", id }, due),
            fireAt: atMinuteOfDay(addDays(due, 1), 540),
            entityId: launch.entityId,
            storeId: launch.storeId,
            payload: { dueDate: due },
          });
      }
    }
  } finally {
    active.delete(tx);
    withdrawing.delete(tx);
  }
}

export const cancelReviewPublishMachines = [
  implementKeyed(machinePort, chainKey("patrol_task", "status"), {
    guards: { [rowKey("11:547", "patrol.void")]: cancelPublishGuard },
    activity: () => ({
      category: "delivery",
      action: "publish.patrol_task.void",
      summary: "取消订单项作废巡检",
    }),
  }),
  implementKeyed(machinePort, chainKey("takedown_task", "status"), {
    guards: { [rowKey("11:653", "takedown.create")]: cancelPublishGuard },
    activity: () => ({
      category: "delivery",
      action: "publish.takedown_task.create",
      summary: "取消订单项创建下架核查",
    }),
  }),
];
