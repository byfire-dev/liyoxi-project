import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import type { ApprovalRequest } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import type { Tx } from "../kernel/index.js";
import type { PublishDeps } from "./context.js";
import {
  accountOf,
  taskOf,
  actorName,
  staffBrief,
  dictRef,
  reasons,
  iso,
  dateOf,
  snapshotOf,
  episodeUrlsOf,
} from "./repo.js";
import type { AccountRow, TaskRow } from "./repo.js";
export const brief = (a: AccountRow | TaskRow["channelAccount"]) => ({
  channelAccountId: a.id,
  platform: a.platform,
  accountName: a.accountName,
  accountUid: a.accountUid,
  status: a.status,
});
export async function checks(tx: Tx, a: ApprovalRequest, merchant = false) {
  if (!a.checklistCode || !a.checklistVersionNo) return [];
  const template = await tx.checklistTemplate.findUnique({
    where: { code_versionNo: { code: a.checklistCode, versionNo: a.checklistVersionNo } },
  });
  const items = template ? ChecklistItemsSchema.parse(template.items) : [];
  const result = (a.checklistResult ?? []) as Array<{
    key: string;
    result: "pass" | "fail" | "na";
    note?: string;
  }>;
  return result.flatMap((r) => {
    const item = items.find((i) => i.key === r.key);
    if (!item || (merchant && !item.merchantVisible)) return [];
    return [
      {
        key: r.key,
        label: item.label,
        result: r.result,
        note: r.note ?? null,
        ...(!merchant ? { merchantVisible: item.merchantVisible } : {}),
      },
    ];
  });
}
async function usage(tx: Tx, id: string) {
  const rows = await tx.orderItemAccount.findMany({
    where: { channelAccountId: id },
    include: { orderItem: true },
  });
  const count = (phase: string) => rows.filter((r) => r.orderItem.phase === phase).length;
  return {
    counts: {
      pendingStartCount: count("pending_start"),
      producingCount: count("producing"),
      toLaunchCount: count("to_launch"),
      liveCount: count("live"),
    },
    activeDramas: rows
      .filter((r) =>
        ["pending_start", "producing", "to_launch", "live"].includes(r.orderItem.phase),
      )
      .sort(
        (a, b) =>
          (dateOf(a.orderItem.agreedLaunchDate) ?? "9999").localeCompare(
            dateOf(b.orderItem.agreedLaunchDate) ?? "9999",
          ) || a.orderItemId.localeCompare(b.orderItemId),
      )
      .slice(0, 5)
      .map((r) => ({
        orderItemId: r.orderItemId,
        dramaTitle: snapshotOf(r.orderItem.dramaSnapshot).title ?? "",
        phase: r.orderItem.phase,
        agreedLaunchDate: dateOf(r.orderItem.agreedLaunchDate),
      })),
    openTakedownTaskCount: await tx.takedownTask.count({
      where: { channelAccountId: id, status: { in: ["pending_merchant", "merchant_confirmed"] } },
    }),
  };
}
export async function storeBrief(tx: Tx, storeId: string) {
  const store = await tx.store.findUniqueOrThrow({
    where: { id: storeId },
    include: { entity: true, storeProfileStore: true },
  });
  return {
    storeId,
    storeName: store.name,
    entityId: store.entityId,
    entityName: store.entity.name,
    city: await dictRef(tx, "region", store.storeProfileStore?.cityCode ?? null),
    district: await dictRef(tx, "region", store.storeProfileStore?.districtCode ?? null),
    qualificationStatus: store.qualificationStatus,
  };
}
export async function accountCard(tx: Tx, a: AccountRow) {
  const last = a.channelAccountSubmissions[0]!,
    u = await usage(tx, a.id),
    filled = last.filledSnapshot as { accountType: string };
  return {
    ...brief(a),
    accountType: a.accountType,
    submittedAccountType: filled.accountType,
    certSubjectName: a.certSubjectName,
    abnormalSource: a.abnormalSource,
    abnormalReason: await dictRef(tx, "reject_reason", a.abnormalReasonCode),
    abnormalNote: a.abnormalNote,
    roundNo: last.roundNo,
    submittedAt: iso(a.submittedAt),
    reviewDueAt: last.approvalRequest.status === "pending" ? iso(last.approvalRequest.dueAt) : null,
    verifiedAt: iso(a.verifiedAt),
    usage: {
      inProgressCount: u.counts.pendingStartCount + u.counts.producingCount,
      toLaunchCount: u.counts.toLaunchCount,
      liveCount: u.counts.liveCount,
    },
    openTakedownTaskCount: u.openTakedownTaskCount,
    actions: a.status === "abnormal" ? ["submit"] : [],
  };
}
export async function approvalView(
  tx: Tx,
  deps: PublishDeps,
  staff: StaffContext,
  a: ApprovalRequest,
) {
  return {
    ...(await deps.approval.decisionView(tx, staff, a.id)),
    submitter: {
      actorType: a.submitActorType,
      actorId: a.submitActorId,
      label: (await actorName(tx, a.submitActorType, a.submitActorId, a.entityId!)) ?? "系统",
    },
    submitClient: a.submitClient,
    checklist:
      a.checklistCode && a.checklistVersionNo
        ? { code: a.checklistCode, versionNo: a.checklistVersionNo, result: await checks(tx, a) }
        : null,
    confirmChecks: a.confirmChecks,
  };
}
export async function accountRow(tx: Tx, a: AccountRow, _staff: StaffContext) {
  const u = await usage(tx, a.id),
    last = a.channelAccountSubmissions[0]!,
    prev = a.channelAccountSubmissions[1]?.approvalRequest;
  return {
    ...brief(a),
    store: await storeBrief(tx, a.storeId),
    accountType: a.accountType,
    submittedAccountType: (last.filledSnapshot as { accountType: string }).accountType,
    certSubjectName: a.certSubjectName,
    isCertSubjectMatched:
      a.accountType === "enterprise"
        ? (a.certSubjectName ?? "").replace(/\s/g, "") ===
          (a.store.entity.name ?? "").replace(/\s/g, "")
        : null,
    abnormalSource: a.abnormalSource,
    abnormalReason: await dictRef(tx, "reject_reason", a.abnormalReasonCode),
    abnormalNote: a.abnormalNote,
    boundAt: iso(a.createdAt),
    submittedAt: iso(a.submittedAt),
    verifiedAt: iso(a.verifiedAt),
    verifiedBy: await staffBrief(tx, a.verifiedByStaffId),
    unboundAt: iso(a.unboundAt),
    latestRound: {
      channelAccountSubmissionId: last.id,
      roundNo: last.roundNo,
      kind: last.kind,
      submittedAt: iso(last.submittedAt),
      approvalId: last.approvalRequestId,
      approvalStatus: last.approvalRequest.status,
      dueAt: iso(last.approvalRequest.dueAt),
    },
    previousDecision: prev?.decidedAt
      ? {
          roundNo: prev.roundNo,
          decidedAt: iso(prev.decidedAt),
          decidedBy: await staffBrief(tx, prev.decidedByStaffId),
          result: prev.status,
          reasons: await reasons(tx, prev.reasonCodes),
        }
      : null,
    usage: u.counts,
    activeDramas: u.activeDramas,
    openTakedownTaskCount: u.openTakedownTaskCount,
    actions: [],
  };
}
async function accountHistory(tx: Tx, a: AccountRow) {
  const rows = await tx.statusTransition.findMany({
    where: { machine: "channel_account", subjectId: a.id },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const kinds: Record<string, string> = {
    "account.bind": "bound",
    "account.resubmit": "resubmitted",
    "account.verify_pass": "verified",
    "account.verify_reject": "rejected",
  };
  return Promise.all(
    rows.map(async (r) => ({
      at: iso(r.occurredAt),
      kind: kinds[r.event] ?? "abnormal",
      actorType: r.actorType,
      actorName: await actorName(tx, r.actorType, r.actorId, a.entityId),
      reasons: r.reasonCode ? await reasons(tx, [r.reasonCode]) : [],
      note: r.note,
    })),
  );
}
async function accountRounds(tx: Tx, deps: PublishDeps, a: AccountRow, staff: StaffContext) {
  return Promise.all(
    a.channelAccountSubmissions.map(async (r) => ({
      channelAccountSubmissionId: r.id,
      roundNo: r.roundNo,
      kind: r.kind,
      submittedAt: iso(r.submittedAt),
      filled: r.filledSnapshot,
      screenshotCount: r.screenshotFileIds.length,
      compareRows: r.compareResult,
      approval: await approvalView(tx, deps, staff, r.approvalRequest),
    })),
  );
}
export async function accountDetail(tx: Tx, deps: PublishDeps, id: string, staff: StaffContext) {
  const a = await accountOf(tx, id, staff);
  return {
    ...(await accountRow(tx, a, staff)),
    rounds: await accountRounds(tx, deps, a, staff),
    history: await accountHistory(tx, a),
  };
}
export async function accountSubmissionDetail(
  tx: Tx,
  deps: PublishDeps,
  id: string,
  staff: StaffContext,
) {
  const r = await tx.channelAccountSubmission.findUniqueOrThrow({ where: { id } }),
    a = await accountOf(tx, r.channelAccountId, staff, true),
    filled = r.filledSnapshot as { accountName: string; accountUid: string; accountType: string },
    rounds = await accountRounds(tx, deps, a, staff);
  const compareRows =
    r.compareResult ??
    COMPARE_FIELDS.map((field) => ({
      field,
      filled:
        field === "account_name"
          ? filled.accountName
          : field === "account_uid"
            ? filled.accountUid
            : field === "account_type"
              ? filled.accountType
              : field === "cert_subject_name"
                ? a.store.entity.name
                : null,
      recognized: null,
      match: null,
    }));
  return {
    channelAccountSubmissionId: r.id,
    roundNo: r.roundNo,
    kind: r.kind,
    isCurrentRound: a.channelAccountSubmissions[0]?.id === r.id,
    submittedAt: iso(r.submittedAt),
    submittedByName: (await actorName(tx, "merchant", r.submittedByUserId, r.entityId)) ?? "商家",
    account: await accountRow(tx, a, staff),
    filled: r.filledSnapshot,
    screenshots: r.screenshotFileIds.map((fileId) => ({
      fileId,
      url: null as string | null,
      expiresAt: null as string | null,
    })),
    compareRows,
    approval: rounds.find((row) => row.channelAccountSubmissionId === r.id)!.approval,
    otherRounds: rounds.filter((row) => row.channelAccountSubmissionId !== r.id),
    history: await accountHistory(tx, a),
    actions:
      a.channelAccountSubmissions.find((s) => s.id === id)?.approvalRequest.status === "pending" &&
      hasPermission(staff, "publish.account.verify")
        ? ["approve", "reject"]
        : [],
  };
}
export async function signScreenshots<
  T extends {
    screenshots: Array<{ fileId: string; url: string | null; expiresAt: string | null }>;
  },
>(deps: PublishDeps, view: T, replayed = false) {
  if (!replayed)
    for (const image of view.screenshots)
      Object.assign(image, await deps.media.signRead({ fileId: image.fileId, audience: "staff" }));
  return view;
}
export function todo(task: TaskRow) {
  return (
    task.reviewStatus !== "void" &&
    task.verifiedEpisodeCount < task.orderItem.episodeCount &&
    ["awaiting_launch", "launch_verify", "in_service"].includes(task.deliveryTicket.step)
  );
}
export async function taskCard(tx: Tx, task: TaskRow, now: Date) {
  const r = task.launchSubmissions[0],
    returned = task.launchSubmissions.find((s) => s.result === "returned");
  const maySubmit =
    ["pending", "need_fix", "passed"].includes(task.reviewStatus) &&
    task.verifiedEpisodeCount < task.orderItem.episodeCount &&
    ["awaiting_launch", "launch_verify", "in_service"].includes(task.deliveryTicket.step) &&
    task.deliveryTicket.pauseCount === 0 &&
    calendarDate(now) <= dateOf(task.orderItem.usageEndDate)!;
  return {
    launchTaskId: task.id,
    orderItemId: task.orderItemId,
    platform: task.platform,
    channelAccount: brief(task.channelAccount),
    reviewStatus: task.reviewStatus,
    isLive: task.isLive,
    wentLiveAt: iso(task.wentLiveAt),
    verifiedEpisodeCount: task.verifiedEpisodeCount,
    firstLaunchDate: dateOf(task.firstLaunchDate),
    completedAt: iso(task.completedAt),
    voidReason: task.voidReason,
    latestSubmission: r
      ? {
          roundNo: r.roundNo,
          linkKind: r.linkKind,
          collectionUrl: r.collectionUrl,
          episodeUrlCount: episodeUrlsOf(r.episodeUrls).length,
          reportedEpisodeCount: r.reportedEpisodeCount,
          actualLaunchDate: dateOf(r.actualLaunchDate),
          submittedAt: iso(r.submittedAt),
          result: r.result,
        }
      : null,
    reviewDueAt: task.reviewStatus === "verifying" && r ? iso(r.approvalRequest.dueAt) : null,
    returnInfo:
      task.reviewStatus === "need_fix" && returned
        ? {
            reasons: await reasons(tx, returned.approvalRequest.reasonCodes),
            note: returned.approvalRequest.decisionNote,
            decidedAt: iso(returned.approvalRequest.decidedAt),
          }
        : null,
    actions: maySubmit ? ["submit"] : [],
  };
}
export function taskBrief(task: TaskRow, now: Date) {
  return {
    launchTaskId: task.id,
    platform: task.platform,
    account: brief(task.channelAccount),
    reviewStatus: task.reviewStatus,
    isLive: task.isLive,
    currentRoundNo: task.currentRoundNo,
    verifiedEpisodeCount: task.verifiedEpisodeCount,
    firstLaunchDate: dateOf(task.firstLaunchDate),
    isOverdue:
      !task.isLive &&
      ["pending", "need_fix"].includes(task.reviewStatus) &&
      !!task.orderItem.agreedLaunchDate &&
      dateOf(task.orderItem.agreedLaunchDate)! < calendarDate(now) &&
      calendarDate(now) <= dateOf(task.orderItem.usageEndDate)! &&
      task.deliveryTicket.pauseCount === 0 &&
      ["to_launch", "live"].includes(task.orderItem.phase),
    currentSubmissionId: task.launchSubmissions[0]?.id ?? null,
    latestPassedSubmissionId:
      task.launchSubmissions.find((r) => ["passed", "passed_partial"].includes(r.result))?.id ??
      null,
  };
}
export async function taskDetail(tx: Tx, deps: PublishDeps, task: TaskRow) {
  const r = task.launchSubmissions.find((s) => ["passed", "passed_partial"].includes(s.result));
  const timeline: Array<Record<string, unknown>> = [
    {
      kind: "created",
      at: iso(task.createdAt),
      roundNo: 0,
      linkKind: null,
      reportedEpisodeCount: null,
      verifiedEpisodeCount: null,
      reasons: [],
      note: null,
    },
  ];
  for (const s of [...task.launchSubmissions].reverse()) {
    const base = {
      roundNo: s.roundNo,
      linkKind: s.linkKind,
      reportedEpisodeCount: s.reportedEpisodeCount,
      verifiedEpisodeCount: s.verifiedEpisodeCount,
      reasons: await reasons(tx, s.approvalRequest.reasonCodes),
      note: s.approvalRequest.decisionNote,
    };
    if (!s.reopenOfLaunchSubmissionId)
      timeline.push({ ...base, kind: "submitted", at: iso(s.submittedAt) });
    if (s.approvalRequest.decidedAt)
      timeline.push({ ...base, kind: s.result, at: iso(s.approvalRequest.decidedAt) });
  }
  return {
    task: await taskCard(tx, task, deps.clock.now()),
    accountType: task.channelAccount.accountType,
    launch: r
      ? {
          linkKind: r.linkKind,
          collectionUrl: r.collectionUrl,
          episodeUrls: episodeUrlsOf(r.episodeUrls),
          reportedEpisodeCount: r.reportedEpisodeCount,
          verifiedEpisodeCount: r.verifiedEpisodeCount,
          actualLaunchDate: dateOf(r.actualLaunchDate),
          verifiedAt: iso(r.approvalRequest.decidedAt),
          verifiedByName: (await staffBrief(tx, r.approvalRequest.decidedByStaffId))?.name ?? null,
        }
      : null,
    verifyChecks: r ? await checks(tx, r.approvalRequest, true) : [],
    timeline: timeline.sort((a, b) => String(a.at).localeCompare(String(b.at))),
    patrols: [],
  };
}
export async function launchDetail(tx: Tx, deps: PublishDeps, id: string, staff: StaffContext) {
  const r = await tx.launchSubmission.findUniqueOrThrow({
      where: { id },
      include: { approvalRequest: true },
    }),
    task = await taskOf(tx, r.launchTaskId, staff),
    item = task.orderItem,
    ticket = task.deliveryTicket;
  const letter = await tx.licenseLetter.findFirst({
    where: {
      orderItemId: item.id,
      channelAccountId: task.channelAccountId,
      status: { not: "voided" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, letterNo: true, status: true },
  });
  const siblings = await tx.launchTask.findMany({
    where: { orderItemId: item.id, id: { not: task.id }, reviewStatus: { not: "void" } },
    select: { id: true },
  });
  const rounds = await Promise.all(
    task.launchSubmissions.map(async (s) => ({
      launchSubmissionId: s.id,
      roundNo: s.roundNo,
      result: s.result,
      submittedAt: iso(s.submittedAt),
      reportedEpisodeCount: s.reportedEpisodeCount,
      verifiedEpisodeCount: s.verifiedEpisodeCount,
      actualLaunchDate: dateOf(s.actualLaunchDate),
      reopenOfLaunchSubmissionId: s.reopenOfLaunchSubmissionId,
      decidedAt: iso(s.approvalRequest.decidedAt),
      decidedBy: await staffBrief(tx, s.approvalRequest.decidedByStaffId),
      reasons: await reasons(tx, s.approvalRequest.reasonCodes),
      decisionNote: s.approvalRequest.decisionNote,
    })),
  );
  return {
    launchSubmissionId: r.id,
    launchTaskId: task.id,
    roundNo: r.roundNo,
    result: r.result,
    isCurrentRound: task.currentRoundNo === r.roundNo,
    reopenOfLaunchSubmissionId: r.reopenOfLaunchSubmissionId,
    link: {
      linkKind: r.linkKind,
      collectionUrl: r.collectionUrl,
      episodeUrls: episodeUrlsOf(r.episodeUrls),
      reportedEpisodeCount: r.reportedEpisodeCount,
      actualLaunchDate: dateOf(r.actualLaunchDate),
      submittedAt: iso(r.submittedAt),
      submitActorType: r.submitActorType,
      submitClient: r.submitClient,
      submittedByName: await actorName(tx, r.submitActorType, r.submitActorId, r.entityId),
    },
    verifiedEpisodeCount: r.verifiedEpisodeCount,
    evidenceFileIds: r.evidenceFileIds,
    account: { ...brief(task.channelAccount), accountType: task.channelAccount.accountType },
    task: {
      ...taskBrief(task, deps.clock.now()),
      wentLiveAt: iso(task.wentLiveAt),
      completedAt: iso(task.completedAt),
    },
    orderItem: {
      orderItemId: item.id,
      orderId: item.dramaOrderId,
      orderNo: item.dramaOrder.orderNo,
      orderedAt: iso(item.dramaOrder.submittedAt),
      dramaTitle: snapshotOf(item.dramaSnapshot).title ?? "",
      episodeCount: item.episodeCount,
      productionModel: item.productionModel,
      phase: item.phase,
      agreedLaunchDate: dateOf(item.agreedLaunchDate),
      usageStartDate: dateOf(item.usageStartDate),
      usageEndDate: dateOf(item.usageEndDate),
      usageEndSource: item.usageEndSource,
      liveEpisodeCount: item.liveEpisodeCount,
    },
    ticket: {
      deliveryTicketId: ticket.id,
      ticketNo: ticket.ticketNo,
      step: ticket.step,
      isPaused: ticket.pauseCount > 0,
      pauseReasons: ticket.deliveryTicketPauses.filter((p) => !p.releasedAt).map((p) => p.reason),
      deliveryManager: await staffBrief(tx, ticket.deliveryManagerId),
      publisher: await staffBrief(tx, ticket.publisherId),
      deliveryTargetAt: iso(ticket.deliveryTargetAt),
      deliveredAt: iso(ticket.deliveredAt),
    },
    store: await storeBrief(tx, task.storeId),
    licenseLetter: letter
      ? { licenseLetterId: letter.id, letterNo: letter.letterNo, status: letter.status }
      : null,
    approval: await approvalView(tx, deps, staff, r.approvalRequest),
    projectedUsageStartDate:
      [dateOf(item.usageStartDate), dateOf(r.actualLaunchDate)]
        .filter((s): s is string => s !== null)
        .sort()[0] ?? null,
    isPartialGoesLive: (await paramsAt(tx, ["launch.partial_goes_live"], deps.clock.now()))[
      "launch.partial_goes_live"
    ],
    rounds,
    otherTasks: await Promise.all(
      siblings.map(async (s) => taskBrief(await taskOf(tx, s.id), deps.clock.now())),
    ),
    revoke: null,
    actions:
      r.approvalRequest.status === "pending" &&
      hasPermission(staff, "publish.link.verify") &&
      (staff.moduleLevels.publish !== "o" || ticket.publisherId === staff.staff.id)
        ? ["approve", "reject"]
        : [],
  };
}
