import { PlatformSchema } from "@liyoxi/contract";
import type {
  ChannelAccountCreateBody,
  ChannelAccountSubmitBody,
  LaunchTaskSubmitBody,
  ChannelAccountApproveBody,
  ChannelAccountRejectBody,
  LaunchApproveBody,
  LaunchRejectBody,
} from "@liyoxi/contract";
import { defineApprovalKind } from "../approval/index.js";
import type { ApprovalRow, ApprovalDecision } from "../approval/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, lockRows, uuidv7, isUniqueViolation } from "../kernel/index.js";
import type { Tx, IdentityContext } from "../kernel/index.js";
import type { PublishDeps, PublishViewer } from "./context.js";
import { accountOf, taskOf, lockTask } from "./repo.js";
import {
  normalize,
  owner,
  gate,
  files,
  reasonScene,
  invalid,
  checklist,
  liveWindow,
  submittedLinks,
} from "./validate.js";
import { checked } from "./machines.js";
import { launchChangedPort, launchHandlerPort } from "./ports.js";
import { boundAssembly } from "./binding.js";
type Body =
  ChannelAccountApproveBody | ChannelAccountRejectBody | LaunchApproveBody | LaunchRejectBody;
const calls = new WeakMap<
  Tx,
  { deps: PublishDeps; ctx: IdentityContext; staff: StaffContext; body: Body; approving: boolean }
>();
export async function withDecision<T>(
  tx: Tx,
  deps: PublishDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  body: Body,
  approving: boolean,
  fn: () => Promise<T>,
) {
  if (calls.has(tx)) throw new Error("publish 决定不能重入");
  calls.set(tx, { deps, ctx, staff, body, approving });
  try {
    return await fn();
  } finally {
    calls.delete(tx);
  }
}
const call = (tx: Tx) => {
  const c = calls.get(tx);
  if (!c) throw new Error("publish 审批只能从领域用例进入");
  return c;
};
export async function bindAccount(
  tx: Tx,
  deps: PublishDeps,
  viewer: PublishViewer,
  body: ChannelAccountCreateBody,
) {
  owner(viewer);
  const { storeId, entityId } = viewer.membership;
  await lockRows(tx, "entity", [entityId], "share");
  await lockRows(tx, "store", [storeId], "share");
  await gate(tx, storeId);
  if (!body.accountName.trim() || !normalize(body.accountUid))
    throw invalid("accountUid", "账号名称与 ID 不得为空白");
  const now = deps.clock.now(),
    id = uuidv7();
  try {
    await tx.channelAccount.create({
      data: {
        id,
        entityId,
        storeId,
        platform: body.platform,
        accountName: body.accountName,
        accountUid: body.accountUid,
        accountUidNorm: normalize(body.accountUid),
        status: "pending_verify",
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error, ["uq_channel_account_platform_uid_active"]))
      throw new AppError("CHANNEL_ACCOUNT_TAKEN");
    throw error;
  }
  const approval = await submitAccount(tx, deps, viewer, id, body, 1, "new_binding");
  await deps.flow.transition(tx, viewer.ctx, {
    machine: "channel_account",
    stateField: "status",
    id,
    event: "account.bind",
    created: true,
    args: checked(),
    entityId,
    storeId,
    payload: { roundNo: 1 },
    emit: {
      type: "account.submitted",
      payload: {
        v: 1,
        channelAccountId: id,
        entityId,
        storeId,
        platform: body.platform,
        approvalRequestId: approval.approvalId,
      },
    },
  });
  return id;
}
async function submitAccount(
  tx: Tx,
  deps: PublishDeps,
  viewer: PublishViewer,
  id: string,
  body: ChannelAccountSubmitBody,
  roundNo: number,
  kind: "new_binding" | "resubmit",
) {
  const a = await accountOf(tx, id),
    submissionId = uuidv7(),
    now = deps.clock.now();
  const filled = {
    platform: a.platform,
    accountName: a.accountName,
    accountUid: a.accountUid,
    accountType: body.accountType,
  };
  const approval = await deps.approval.submit(tx, viewer.ctx, {
    kind: "channel_account",
    subjectType: "channel_account",
    subjectId: id,
    entityId: a.entityId,
    storeId: a.storeId,
    input: { submissionId, roundNo, title: a.accountName, filled },
  });
  await files(tx, body.screenshotFileIds, a, "channel_screenshot", viewer.ctx.actor.id!);
  await tx.channelAccountSubmission.create({
    data: {
      id: submissionId,
      entityId: a.entityId,
      storeId: a.storeId,
      channelAccountId: id,
      roundNo,
      kind,
      filledSnapshot: filled,
      screenshotFileIds: body.screenshotFileIds,
      approvalRequestId: approval.approvalId,
      submittedByUserId: viewer.ctx.actor.id!,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const fileId of [...body.screenshotFileIds].sort())
    await deps.media.link(tx, {
      fileId,
      refType: "channel_account_submission",
      refId: submissionId,
      role: "screenshot",
      entityId: a.entityId,
      storeId: a.storeId,
    });
  return approval;
}
export async function resubmitAccount(
  tx: Tx,
  deps: PublishDeps,
  viewer: PublishViewer,
  id: string,
  body: ChannelAccountSubmitBody,
) {
  owner(viewer);
  await lockRows(tx, "entity", [viewer.membership.entityId], "share");
  await lockRows(tx, "store", [viewer.membership.storeId], "share");
  await gate(tx, viewer.membership.storeId);
  await lockRows(tx, "channel_account", [id]);
  const a = await accountOf(tx, id);
  if (a.storeId !== viewer.membership.storeId) throw new AppError("NOT_FOUND");
  if (a.status !== "abnormal") throw new AppError("STATE_NOT_ALLOWED");
  const roundNo = (a.channelAccountSubmissions[0]?.roundNo ?? 0) + 1;
  const approval = await submitAccount(tx, deps, viewer, id, body, roundNo, "resubmit");
  await deps.flow.transition(tx, viewer.ctx, {
    machine: "channel_account",
    stateField: "status",
    id,
    event: "account.resubmit",
    args: checked(),
    entityId: a.entityId,
    storeId: a.storeId,
    set: {
      submitted_at: deps.clock.now(),
      abnormal_source: null,
      abnormal_reason_code: null,
      abnormal_note: null,
    },
    payload: { roundNo },
    emit: {
      type: "account.submitted",
      payload: {
        v: 1,
        channelAccountId: id,
        entityId: a.entityId,
        storeId: a.storeId,
        platform: PlatformSchema.parse(a.platform),
        approvalRequestId: approval.approvalId,
      },
    },
  });
}
export async function submitLaunch(
  tx: Tx,
  deps: PublishDeps,
  viewer: PublishViewer,
  id: string,
  body: LaunchTaskSubmitBody,
) {
  owner(viewer);
  const task = await lockTask(tx, id);
  if (task.storeId !== viewer.membership.storeId) throw new AppError("NOT_FOUND");
  submittedLinks(task, body, deps.clock.now());
  const submissionId = uuidv7(),
    now = deps.clock.now(),
    roundNo = task.currentRoundNo + 1;
  const approval = await deps.approval.submit(tx, viewer.ctx, {
    kind: "launch_link",
    subjectType: "launch_submission",
    subjectId: submissionId,
    entityId: task.entityId,
    storeId: task.storeId,
    deliveryTicketId: task.deliveryTicketId,
    input: { submissionId, roundNo, taskId: id, title: task.channelAccount.accountName },
  });
  await tx.launchSubmission.create({
    data: {
      id: submissionId,
      entityId: task.entityId,
      storeId: task.storeId,
      launchTaskId: id,
      roundNo,
      linkKind: body.linkKind,
      collectionUrl: body.collectionUrl ?? null,
      ...(body.episodeUrls ? { episodeUrls: body.episodeUrls } : {}),
      reportedEpisodeCount: body.reportedEpisodeCount,
      actualLaunchDate: new Date(`${body.actualLaunchDate}T00:00:00Z`),
      submitActorType: "merchant",
      submitActorId: viewer.ctx.actor.id,
      submitClient: viewer.ctx.actor.client,
      submittedAt: now,
      approvalRequestId: approval.approvalId,
      result: "pending",
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.flow.transition(tx, viewer.ctx, {
    machine: "launch_task",
    stateField: "review_status",
    id,
    event: "launch.submit",
    args: checked(),
    entityId: task.entityId,
    storeId: task.storeId,
    set: { current_round_no: roundNo },
    payload: { roundNo, reportedEpisodeCount: body.reportedEpisodeCount },
    emit: {
      type: "launch.submitted",
      payload: {
        v: 1,
        launchTaskId: id,
        orderItemId: task.orderItemId,
        deliveryTicketId: task.deliveryTicketId,
        roundNo,
        approvalRequestId: approval.approvalId,
      },
    },
  });
  await deps.assembly.port(launchChangedPort)(tx, {
    orderItemId: task.orderItemId,
    deliveryTicketId: task.deliveryTicketId,
  });
}
export interface CreateLaunchTasksInput {
  orderItemId: string;
  deliveryTicketId: string;
  channelAccountIds: readonly string[];
}
/** delivery 已完成成片推送的四项守卫；调用方在 release210 前先锁所选账号190。 */
export async function createLaunchTasks(
  tx: Tx,
  deps: PublishDeps,
  ctx: IdentityContext,
  input: CreateLaunchTasksInput,
) {
  const item = await tx.orderItem.findUnique({ where: { id: input.orderItemId } });
  if (!item) throw new AppError("NOT_FOUND");
  await lockRows(tx, "drama_order", [item.dramaOrderId]);
  await lockRows(tx, "order_item", [item.id]);
  await lockRows(tx, "delivery_ticket", [input.deliveryTicketId]);
  await lockRows(tx, "channel_account", input.channelAccountIds);
  const ticket = await tx.deliveryTicket.findUnique({ where: { id: input.deliveryTicketId } });
  if (
    !ticket ||
    ticket.orderItemId !== item.id ||
    ticket.storeId !== item.storeId ||
    ticket.pauseCount ||
    !ticket.deliveredAt ||
    !["delivering", "awaiting_launch", "launch_verify", "in_service"].includes(ticket.step)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const ids: string[] = [];
  for (const accountId of [...new Set(input.channelAccountIds)].sort()) {
    const a = await accountOf(tx, accountId),
      selected = await tx.orderItemAccount.findUnique({
        where: {
          orderItemId_channelAccountId: { orderItemId: item.id, channelAccountId: accountId },
        },
      });
    if (
      !selected ||
      a.storeId !== item.storeId ||
      a.entityId !== item.entityId ||
      a.status === "unbound"
    )
      throw new AppError("PRECONDITION_CHANGED");
    const old = await tx.launchTask.findUnique({
      where: {
        orderItemId_channelAccountId: { orderItemId: item.id, channelAccountId: accountId },
      },
    });
    if (old) {
      ids.push(old.id);
      continue;
    }
    const id = uuidv7(),
      now = deps.clock.now();
    await tx.launchTask.create({
      data: {
        id,
        entityId: item.entityId,
        storeId: item.storeId,
        orderItemId: item.id,
        deliveryTicketId: ticket.id,
        channelAccountId: accountId,
        platform: a.platform,
        reviewStatus: "pending",
        createdAt: now,
        updatedAt: now,
      },
    });
    await deps.flow.transition(tx, ctx, {
      machine: "launch_task",
      stateField: "review_status",
      id,
      event: "launch.create",
      created: true,
      args: checked(),
      entityId: item.entityId,
      storeId: item.storeId,
      emit: {
        type: "launch.created",
        payload: { v: 1, launchTaskId: id, orderItemId: item.id, channelAccountId: accountId },
      },
    });
    ids.push(id);
  }
  return ids;
}
// 領域決定前只鎖 20/30；狀態→自己→本人任務→版本→confirm 次序與共同審批入口相同。
export async function decisionGuard(
  tx: Tx,
  staff: StaffContext,
  approvalId: string,
  body: Body,
  approving: boolean,
  taskId?: string,
) {
  await lockRows(tx, "staff", [staff.staff.id], "share");
  await lockRows(tx, "approval_request", [approvalId]);
  const approval = await tx.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  if (approval.status !== "pending")
    throw new AppError("APPROVAL_NOT_PENDING", {
      details: { status: approval.status, decidedAt: approval.decidedAt?.toISOString() ?? null },
    });
  if (approval.submitActorId === staff.staff.id || approval.requesterStaffId === staff.staff.id)
    throw new AppError("APPROVAL_SELF_FORBIDDEN");
  if (
    taskId &&
    staff.moduleLevels.publish === "o" &&
    (await taskOf(tx, taskId)).deliveryTicket.publisherId !== staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  if (approving && (body as ChannelAccountApproveBody).lockVersion !== approval.lockVersion)
    throw new AppError("VERSION_CONFLICT", { details: { lockVersion: approval.lockVersion } });
  if (
    approving &&
    (!(body as ChannelAccountApproveBody).confirm ||
      (body as ChannelAccountApproveBody).confirm!.roundNo !== approval.roundNo)
  )
    throw new AppError("CONFIRM_MISMATCH");
  return approval;
}
async function accountDecision(
  tx: Tx,
  row: ApprovalRow,
  decision: ApprovalDecision,
  approved: boolean,
) {
  const { deps, ctx, body } = call(tx);
  const first = await tx.channelAccountSubmission.findUnique({
    where: { approvalRequestId: row.id },
  });
  if (!first) throw new AppError("NOT_FOUND");
  await lockRows(tx, "channel_account", [first.channelAccountId]);
  const a = await accountOf(tx, first.channelAccountId),
    round = a.channelAccountSubmissions.find((s) => s.id === first.id)!;
  if (a.status !== "pending_verify" || a.channelAccountSubmissions[0]?.id !== first.id)
    throw new AppError("PRECONDITION_CHANGED");
  const b = body as ChannelAccountApproveBody;
  if (
    approved &&
    b.confirm?.accountUid !== (round.filledSnapshot as { accountUid: string }).accountUid
  )
    throw new AppError("CONFIRM_MISMATCH");
  const filled = round.filledSnapshot as {
    accountName: string;
    accountUid: string;
    accountType: string;
  };
  const rows = b.compareRows.map((r) => ({
    ...r,
    filled:
      r.field === "account_name"
        ? filled.accountName
        : r.field === "account_uid"
          ? filled.accountUid
          : r.field === "account_type"
            ? filled.accountType
            : r.field === "cert_subject_name"
              ? a.store.entity.name
              : null,
  }));
  if (approved) {
    if (
      b.accountType !== "enterprise" &&
      (b.certSubjectName != null ||
        rows.find((r) => r.field === "cert_subject_name")?.recognized != null)
    )
      throw invalid("certSubjectName", "非企业账号的认证主体须为空");
    const mismatch = rows.filter((r) => !r.match).map((r) => r.field);
    if (
      b.accountType === "enterprise" &&
      (!b.certSubjectName ||
        b.certSubjectName.replace(/\s/g, "") !== (a.store.entity.name ?? "").replace(/\s/g, ""))
    )
      mismatch.push("cert_subject_name");
    if (mismatch.length)
      throw new AppError("ACCOUNT_COMPARE_MISMATCH", {
        details: { fields: [...new Set(mismatch)] },
      });
    const c = await checklist(tx, "account.verify", b.checklistVersionNo, b.results, false);
    if (c)
      await tx.approvalRequest.update({
        where: { id: row.id },
        data: { checklistCode: c.code, checklistVersionNo: c.versionNo, checklistResult: c.result },
      });
  } else await reasonScene(tx, decision.reasonCodes, "account_verify");
  await tx.channelAccountSubmission.update({
    where: { id: first.id },
    data: { compareResult: rows, updatedAt: decision.decidedAt },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "channel_account",
    stateField: "status",
    id: a.id,
    event: approved ? "account.verify_pass" : "account.verify_reject",
    args: checked(),
    entityId: a.entityId,
    storeId: a.storeId,
    reasonCode: approved ? null : decision.reasonCodes[0]!,
    note: decision.note,
    set: approved
      ? {
          account_type: b.accountType,
          cert_subject_name: b.accountType === "enterprise" ? b.certSubjectName! : null,
          verified_at: decision.decidedAt,
          verified_by_staff_id: decision.decidedByStaffId,
          abnormal_source: null,
          abnormal_reason_code: null,
          abnormal_note: null,
        }
      : {
          abnormal_source: "verify",
          abnormal_reason_code: decision.reasonCodes[0]!,
          abnormal_note: decision.note,
        },
    payload: { roundNo: round.roundNo },
    emit: approved
      ? {
          type: "account.verified",
          payload: { v: 1, channelAccountId: a.id, entityId: a.entityId, storeId: a.storeId },
        }
      : {
          type: "account.abnormal",
          payload: {
            v: 1,
            channelAccountId: a.id,
            entityId: a.entityId,
            storeId: a.storeId,
            abnormalSource: "verify",
            reasonCode: decision.reasonCodes[0]!,
          },
        },
  });
}
async function launchDecision(
  tx: Tx,
  row: ApprovalRow,
  decision: ApprovalDecision,
  approved: boolean,
) {
  const { deps, ctx, body } = call(tx),
    first = await tx.launchSubmission.findUnique({ where: { approvalRequestId: row.id } });
  if (!first) throw new AppError("NOT_FOUND");
  const task = await lockTask(tx, first.launchTaskId);
  if (
    task.reviewStatus !== "verifying" ||
    task.currentRoundNo !== first.roundNo ||
    first.result !== "pending"
  )
    throw new AppError("PRECONDITION_CHANGED");
  const b = body as LaunchApproveBody;
  if (approved && b.confirm?.reportedEpisodeCount !== first.reportedEpisodeCount)
    throw new AppError("CONFIRM_MISMATCH");
  liveWindow(task, decision.decidedAt, approved);
  if (approved) {
    const min = Math.max(1, task.verifiedEpisodeCount),
      max = first.reportedEpisodeCount;
    if (b.verifiedEpisodeCount < min || b.verifiedEpisodeCount > max)
      throw new AppError("LAUNCH_VERIFY_COUNT_OUT_OF_RANGE", { details: { min, max } });
    const c = (await checklist(tx, "launch.verify", b.checklistVersionNo, b.results))!;
    await tx.approvalRequest.update({
      where: { id: row.id },
      data: { checklistCode: c.code, checklistVersionNo: c.versionNo, checklistResult: c.result },
    });
  } else await reasonScene(tx, decision.reasonCodes, "link_verify");
  const evidence = b.evidenceFileIds ?? [];
  await files(tx, evidence, task, "evidence");
  for (const fileId of [...evidence].sort())
    await deps.media.link(tx, {
      fileId,
      refType: "launch_submission",
      refId: first.id,
      role: "evidence",
      entityId: task.entityId,
      storeId: task.storeId,
    });
  const full = approved && b.verifiedEpisodeCount === task.orderItem.episodeCount,
    partial = (await paramsAt(tx, ["launch.partial_goes_live"], decision.decidedAt))[
      "launch.partial_goes_live"
    ],
    isLive = task.isLive || (approved && (full || partial));
  await tx.launchSubmission.update({
    where: { id: first.id },
    data: {
      result: approved ? (full ? "passed" : "passed_partial") : "returned",
      verifiedEpisodeCount: approved ? b.verifiedEpisodeCount : null,
      evidenceFileIds: evidence,
      updatedAt: decision.decidedAt,
    },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "launch_task",
    stateField: "review_status",
    id: task.id,
    event: approved ? "launch.verify_pass" : "launch.return",
    args: checked(),
    entityId: task.entityId,
    storeId: task.storeId,
    reasonCode: decision.reasonCodes[0] ?? null,
    note: decision.note,
    ...(approved
      ? {
          set: {
            verified_episode_count: b.verifiedEpisodeCount,
            first_launch_date:
              task.firstLaunchDate && task.firstLaunchDate < first.actualLaunchDate
                ? task.firstLaunchDate
                : first.actualLaunchDate,
            completed_at: full ? (task.completedAt ?? decision.decidedAt) : task.completedAt,
            is_live: isLive,
            went_live_at: isLive ? (task.wentLiveAt ?? decision.decidedAt) : null,
          },
        }
      : {}),
    payload: {
      roundNo: first.roundNo,
      verifiedEpisodeCount: approved ? b.verifiedEpisodeCount : task.verifiedEpisodeCount,
    },
    emit: approved
      ? {
          type: "launch.verified",
          payload: {
            v: 1,
            launchTaskId: task.id,
            orderItemId: task.orderItemId,
            verifiedEpisodeCount: b.verifiedEpisodeCount,
            isLive,
          },
        }
      : {
          type: "launch.returned",
          payload: {
            v: 1,
            launchTaskId: task.id,
            orderItemId: task.orderItemId,
            reasonCodes: [...decision.reasonCodes],
          },
        },
  });
  await deps.assembly.port(launchChangedPort)(tx, {
    orderItemId: task.orderItemId,
    deliveryTicketId: task.deliveryTicketId,
  });
}
interface SubmissionInput {
  submissionId: string;
  roundNo: number;
  title: string;
}
export const accountKind = defineApprovalKind<SubmissionInput>({
  category: "review",
  domain: { table: "channel_account_submission", column: "approval_request_id" },
  viewModules: ["publish", "merchant"],
  decidePermission: "publish.account.verify",
  groupBound: false,
  roleQueue: true,
  hasExecution: false,
  numberPrefix: null,
  dedupeKey: (s) => `channel_account:${s.subjectId}`,
  roundNo: async (_tx, s) => s.input.roundNo,
  operations: {
    get: "admin.channelAccountSubmission.get",
    approve: "admin.channelAccountSubmission.approve",
    reject: "admin.channelAccountSubmission.reject",
    withdraw: null,
  },
  validate: async () => {},
  summarize: async (_tx, s) => ({
    title: s.input.title,
    domain: { type: "channel_account_submission", id: s.input.submissionId },
  }),
  revalidate: async () => {},
  onApproved: (tx, row, d) => accountDecision(tx, row, d, true),
  onRejected: (tx, row, d) => accountDecision(tx, row, d, false),
  onWithdrawn: async () => {
    throw new AppError("STATE_NOT_ALLOWED");
  },
});
export const launchKind = defineApprovalKind<SubmissionInput>({
  category: "review",
  domain: { table: "launch_submission", column: "approval_request_id" },
  viewModules: ["publish"],
  decidePermission: "publish.link.verify",
  groupBound: false,
  hasExecution: false,
  numberPrefix: null,
  dedupeKey: (s) => `launch_link:${s.input.submissionId}`,
  roundNo: async (_tx, s) => s.input.roundNo,
  operations: {
    get: "admin.launchSubmission.get",
    approve: "admin.launchSubmission.approve",
    reject: "admin.launchSubmission.reject",
    withdraw: null,
  },
  validate: async () => {},
  summarize: async (_tx, s) => ({
    title: s.input.title,
    domain: { type: "launch_submission", id: s.input.submissionId },
  }),
  handlerOf: (tx, row) => boundAssembly().port(launchHandlerPort)(tx, row.deliveryTicketId!),
  revalidate: async () => {},
  onApproved: (tx, row, d) => launchDecision(tx, row, d, true),
  onRejected: (tx, row, d) => launchDecision(tx, row, d, false),
  onWithdrawn: async () => {
    throw new AppError("STATE_NOT_ALLOWED");
  },
});
