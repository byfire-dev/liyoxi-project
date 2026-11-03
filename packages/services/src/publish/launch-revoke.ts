import { LaunchSubmissionRevokeBodySchema } from "@liyoxi/contract";
import type { LaunchSubmissionRevokeBody } from "@liyoxi/contract";
import { Prisma } from "@liyoxi/db";
import { assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import type { Sla } from "../sla/index.js";
import { closeSystemFollowUps } from "../staff/index.js";
import { createTimers } from "../timers/index.js";
import type { PublishDeps, PublishWriteOptions } from "./context.js";
import { launchChangedPort } from "./ports.js";
import { checked } from "./machines.js";
import { taskOf } from "./repo.js";
import { launchDetail } from "./views.js";
import { withLaunchRevokePatrols } from "./launch-revoke-guard.js";

export type LaunchRevokeDeps = PublishDeps & { sla: Sla };

/** All lower-rank owners are locked through delivery's existing transaction port. */
async function revoke(
  tx: Tx,
  deps: LaunchRevokeDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: LaunchSubmissionRevokeBody,
) {
  const first = await tx.launchSubmission.findUnique({ where: { id } });
  if (!first) throw new AppError("NOT_FOUND");
  const initial = await taskOf(tx, first.launchTaskId, staff);
  await deps.assembly.port(launchChangedPort)(tx, {
    phase: "prelock",
    orderItemId: initial.orderItemId,
    deliveryTicketId: initial.deliveryTicketId,
    staffId: staff.staff.id,
  });
  const task = await taskOf(tx, initial.id, staff),
    now = deps.clock.now();
  const old = task.launchSubmissions.find((r) => r.id === id);
  const latest = task.launchSubmissions.find((r) =>
    ["passed", "passed_partial"].includes(r.result),
  );
  if (
    !old ||
    latest?.id !== id ||
    task.reviewStatus !== "passed" ||
    task.deliveryTicket.step !== "in_service"
  )
    throw new AppError("STATE_NOT_ALLOWED");
  if (task.deliveryTicket.pauseCount)
    throw new AppError("TICKET_ON_HOLD", {
      details: {
        reasons: task.deliveryTicket.deliveryTicketPauses
          .filter((p) => !p.releasedAt)
          .map((p) => p.reason),
      },
    });
  if (
    old.approvalRequest.status !== "approved" ||
    !old.approvalRequest.decidedAt ||
    old.verifiedEpisodeCount === null
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const policy = (await paramsAt(tx, ["launch.verify_revoke_window"], now))[
    "launch.verify_revoke_window"
  ];
  const { dueAt } = await deps.sla.dueAt(tx, {
    policy: "launch.verify_revoke_window",
    ...policy,
    from: old.approvalRequest.decidedAt,
    workHours: await workHoursAt(tx, now),
  });
  if (now > dueAt)
    throw new AppError("LAUNCH_REVOKE_WINDOW_CLOSED", {
      details: { deadlineAt: dueAt.toISOString() },
    });
  const blocked = await tx.takedownTask.findMany({
    where: {
      orderItemId: task.orderItemId,
      OR: [{ merchantConfirmedAt: { not: null } }, { status: "checked" }],
    },
    select: { id: true },
  });
  if (blocked.length)
    throw new AppError("LAUNCH_REVOKE_BLOCKED", {
      details: { takedownTaskIds: blocked.map((t) => t.id).sort() },
    });
  if (
    body.confirm.roundNo !== old.roundNo ||
    body.confirm.verifiedEpisodeCount !== old.verifiedEpisodeCount
  )
    throw new AppError("CONFIRM_MISMATCH");

  const idNew = uuidv7(),
    roundNo = task.currentRoundNo + 1;
  const approval = await deps.approval.submit(tx, ctx, {
    kind: "launch_link",
    subjectType: "launch_submission",
    subjectId: idNew,
    entityId: task.entityId,
    storeId: task.storeId,
    deliveryTicketId: task.deliveryTicketId,
    input: {
      submissionId: idNew,
      roundNo,
      taskId: task.id,
      title: task.channelAccount.accountName,
    },
  });
  await tx.launchSubmission.update({ where: { id }, data: { result: "revoked", updatedAt: now } });
  await tx.launchSubmission.create({
    data: {
      id: idNew,
      entityId: old.entityId,
      storeId: old.storeId,
      launchTaskId: task.id,
      roundNo,
      linkKind: old.linkKind,
      collectionUrl: old.collectionUrl,
      episodeUrls: old.episodeUrls ?? Prisma.DbNull,
      reportedEpisodeCount: old.reportedEpisodeCount,
      actualLaunchDate: old.actualLaunchDate,
      submitActorType: old.submitActorType,
      submitActorId: old.submitActorId,
      submitClient: old.submitClient,
      submittedAt: old.submittedAt,
      approvalRequestId: approval.approvalId,
      result: "pending",
      reopenOfLaunchSubmissionId: id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const remaining = task.launchSubmissions.filter(
    (r) => r.id !== id && ["passed", "passed_partial"].includes(r.result),
  );
  const live = [] as typeof remaining;
  for (const row of remaining) {
    const partial = (
      await paramsAt(tx, ["launch.partial_goes_live"], row.approvalRequest.decidedAt!)
    )["launch.partial_goes_live"];
    if (row.verifiedEpisodeCount === task.orderItem.episodeCount || partial) live.push(row);
  }
  const minDate = (values: Date[]) => values.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const isLive = live.length > 0,
    verifiedEpisodeCount = Math.max(0, ...remaining.map((r) => r.verifiedEpisodeCount ?? 0));
  await deps.flow.transition(tx, ctx, {
    machine: "launch_task",
    stateField: "review_status",
    id: task.id,
    event: "launch.verify_revoke",
    ref: "11:303",
    args: checked(),
    entityId: task.entityId,
    storeId: task.storeId,
    audit: {
      stream: "activity",
      category: "review",
      action: "publish.launch_task.verify_revoke",
      summary: "撤销上线核验通过",
      target: { type: "launch_task", id: task.id },
      entityId: task.entityId,
      storeId: task.storeId,
      reason: { code: "other", text: body.reason },
    },
    note: body.reason,
    set: {
      current_round_no: roundNo,
      verified_episode_count: verifiedEpisodeCount,
      first_launch_date: minDate(remaining.map((r) => r.actualLaunchDate)),
      completed_at: minDate(
        remaining
          .filter((r) => r.verifiedEpisodeCount === task.orderItem.episodeCount)
          .map((r) => r.approvalRequest.decidedAt!),
      ),
      is_live: isLive,
      went_live_at: minDate(live.map((r) => r.approvalRequest.decidedAt!)),
    },
    payload: {
      roundNo,
      revokedSubmissionId: id,
      reopenedSubmissionId: idNew,
      verifiedEpisodeCount,
      isLive,
    },
    emit: {
      type: "launch.verify_revoked",
      payload: { v: 1, launchTaskId: task.id, orderItemId: task.orderItemId, isLive },
    },
  });
  const patrols = await tx.patrolTask.findMany({
    where: { launchTaskId: task.id, status: { in: ["pending", "abnormal"] } },
    orderBy: { id: "asc" },
  });
  const timers = createTimers({ assembly: deps.assembly });
  await withLaunchRevokePatrols(
    tx,
    patrols.map((p) => p.id),
    async (args) => {
      for (const patrol of patrols) {
        await deps.flow.transition(tx, ctx, {
          machine: "patrol_task",
          stateField: "status",
          id: patrol.id,
          event: "patrol.void",
          ref: "11:547",
          args,
          entityId: task.entityId,
          storeId: task.storeId,
          note: body.reason,
          payload: { revokedLaunchSubmissionId: id },
          emit: { type: "patrol.voided", payload: { v: 1, patrolTaskId: patrol.id } },
        });
        await timers.cancel(tx, {
          subject: { type: "patrol_task", id: patrol.id },
          kinds: ["patrol.followup"],
        });
      }
    },
  );
  await closeSystemFollowUps(tx, ctx, {
    subjects: patrols.map((p) => ({ subjectType: "patrol_task" as const, subjectId: p.id })),
    now,
  });
  await tx.takedownTask.updateMany({
    where: {
      orderItemId: task.orderItemId,
      channelAccountId: task.channelAccountId,
      status: "pending_merchant",
    },
    data: { basis: isLive ? "live" : "delivered_unverified", updatedAt: now },
  });
  await deps.assembly.port(launchChangedPort)(tx, {
    orderItemId: task.orderItemId,
    deliveryTicketId: task.deliveryTicketId,
  });
  return launchDetail(tx, deps, idNew, staff);
}

export function createLaunchRevoke(deps: LaunchRevokeDeps) {
  return {
    revoke: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: LaunchSubmissionRevokeBody,
      options: PublishWriteOptions = {},
    ) => {
      assertPermission(staff, "publish.link.verify_revoke", deps.clock.now());
      const body = LaunchSubmissionRevokeBodySchema.parse(input);
      return deps.tx.run((tx) => revoke(tx, deps, ctx, staff, id, body), options);
    },
  };
}
export type LaunchRevoke = ReturnType<typeof createLaunchRevoke>;
