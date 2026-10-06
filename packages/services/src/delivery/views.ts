import { ChecklistItemsSchema, PlanContentSchema } from "@liyoxi/contract";
import type { PlanContent } from "@liyoxi/contract";
import type { Prisma, QcRecord } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";
import type { DeliveryDeps } from "./context.js";
import { iso, dateOf } from "./repo.js";
import type { PlanRow, TicketRow } from "./repo.js";
type Item = PlanRow["dramaOrder"]["orderItems"][number];
const snapshot = (r: Prisma.JsonValue) =>
  r as {
    title?: string;
    genreCodes?: string[];
    posterFileId?: string;
    allowedPlacements?: Array<"opening" | "ending">;
  };
async function dict(tx: Tx, type: string, code: string | null) {
  if (!code) return null;
  const r = await tx.dictItem.findUnique({
    where: { dictTypeKey_code: { dictTypeKey: type, code } },
  });
  return { code, name: r?.name ?? code };
}
const dicts = async (tx: Tx, type: string, codes: readonly string[]) =>
  Promise.all(codes.map(async (c) => (await dict(tx, type, c))!));
const brief = async (tx: Tx, id: string | null) =>
  id ? ((await staffBriefs(tx, [id]))[0] ?? null) : null;
const account = (r: Item["orderItemAccounts"][number]["channelAccount"]) => ({
  channelAccountId: r.id,
  platform: r.platform,
  accountName: r.accountName,
  accountUid: r.accountUid,
  status: r.status,
});
async function storeView(tx: Tx, store: PlanRow["store"]) {
  const profile = store.storeProfileStore;
  return {
    storeId: store.id,
    storeName: store.name,
    entityId: store.entityId,
    entityName: store.entity.name,
    city: await dict(tx, "region", profile?.cityCode ?? null),
    district: await dict(tx, "region", profile?.districtCode ?? null),
    qualificationStatus: store.qualificationStatus,
  };
}
async function planItem(tx: Tx, p: PlanRow, row: PlanContent["items"][number]) {
  const item = p.dramaOrder.orderItems.find((i) => i.id === row.orderItemId)!;
  const accounts = await tx.channelAccount.findMany({
    where: { id: { in: row.accounts.map((a) => a.channelAccountId) } },
  });
  const ads = await tx.ad.findMany({ where: { id: { in: row.placements.map((a) => a.adId) } } });
  return {
    orderItemId: row.orderItemId,
    dramaTitle: snapshot(item.dramaSnapshot).title ?? "",
    episodeCount: item.episodeCount,
    allowedPlacements: snapshot(item.dramaSnapshot).allowedPlacements ?? [],
    accounts: row.accounts.flatMap((a) => {
      const found = accounts.find((r) => r.id === a.channelAccountId);
      return found ? [account(found)] : [];
    }),
    placements: row.placements.flatMap((a) => {
      const found = ads.find((r) => r.id === a.adId);
      return found
        ? [
            {
              slot: a.slot,
              adId: a.adId,
              adNo: found.adNo,
              durationSec: a.durationSec,
              adStatus: found.status,
              confirmedVersionNo: found.confirmedVersionNo,
              copy: found.copy,
            },
          ]
        : [];
    }),
    agreedLaunchDate: row.agreedLaunchDate,
    currentAgreedLaunchDate: dateOf(item.agreedLaunchDate),
    expectedDeliveryDate: row.expectedDeliveryDate,
  };
}
async function assets(tx: Tx, content: PlanContent) {
  const rows = await tx.storeAsset.findMany({
    where: { id: { in: content.referenceAssetIds } },
    include: { storeAssetTags: true },
  });
  return content.referenceAssetIds.flatMap((id) => {
    const r = rows.find((a) => a.id === id);
    return r ? [r] : [];
  });
}
async function adminContent(tx: Tx, p: PlanRow, content: PlanContent) {
  return {
    focus: await dicts(tx, "custom_focus", content.focusTags),
    referenceAssets: (await assets(tx, content)).map((r) => ({
      storeAssetId: r.id,
      type: r.type,
      title: r.title,
    })),
    note: content.note,
    launchMode: content.launchMode,
    items: await Promise.all(content.items.map((r) => planItem(tx, p, r))),
  };
}
const change = (r: PlanRow["deliveryPlanChangeRequests"][number]) => ({
  changeRequestId: r.id,
  onVersionNo: r.onVersionNo,
  kinds: r.kinds,
  note: r.note,
  createdAt: iso(r.createdAt),
  resolvedByVersionNo: r.resolvedByVersionNo,
});
export async function adminPlanView(tx: Tx, p: PlanRow, staff: StaffContext) {
  const changes = await Promise.all(
    p.deliveryPlanChangeRequests.map(async (r) => {
      const member = await tx.entityMember.findFirst({
        where: { entityId: p.entityId, merchantUserId: r.createdByUserId },
      });
      return { ...change(r), createdByName: member?.displayName ?? r.createdByUser.displayName };
    }),
  );
  return {
    deliveryPlanId: p.id,
    orderId: p.dramaOrderId,
    orderNo: p.dramaOrder.orderNo,
    store: await storeView(tx, p.store),
    status: p.status,
    draft: await adminContent(tx, p, PlanContentSchema.parse(p.draft)),
    draftLockVersion: p.draftLockVersion,
    currentVersionNo: p.currentVersionNo,
    confirmedVersionNo: p.confirmedVersionNo,
    pushedAt: iso(p.pushedAt),
    confirmedAt: iso(p.confirmedAt),
    staffDueAt: iso(p.staffDueAt),
    isOrderInAfterSale: !!p.dramaOrder.openCancelRequestId,
    versions: await Promise.all(
      p.deliveryPlanVersions.map(async (v) => ({
        versionNo: v.versionNo,
        pushedAt: iso(v.pushedAt),
        pushedBy: (await brief(tx, v.pushedByStaffId))!,
        changeSummary: v.changeSummary,
        decision: v.decision,
        decidedAt: iso(v.decidedAt),
        decideActorType: v.decideActorType,
        content: await adminContent(tx, p, PlanContentSchema.parse(v.contentSnapshot)),
      })),
    ),
    changeRequests: changes,
    itemWindows: p.dramaOrder.deliveryTickets.map((t) => ({
      orderItemId: t.orderItemId,
      step: t.step,
      canChangeContent: !t.sampleConfirmedAt && !["archived", "terminated"].includes(t.step),
      canChangeAccounts: !t.deliveredAt && !["archived", "terminated"].includes(t.step),
      canReschedule:
        !p.dramaOrder.orderItems.find((i) => i.id === t.orderItemId)?.usageStartDate &&
        !["archived", "terminated"].includes(t.step),
    })),
    lockVersion: p.lockVersion,
    actions:
      hasPermission(staff, "delivery.plan.push") &&
      !p.dramaOrder.openCancelRequestId &&
      p.status !== "confirmed"
        ? ["push"]
        : [],
  };
}
export async function merchantPlanView(tx: Tx, p: PlanRow) {
  const v = p.deliveryPlanVersions.find((r) => r.versionNo === p.currentVersionNo),
    content = v ? PlanContentSchema.parse(v.contentSnapshot) : null;
  const posters: Record<string, string> = {};
  let view = null;
  if (content) {
    const referenceAssets = await Promise.all(
      (await assets(tx, content)).map(async (r) => {
        const tags = r.storeAssetTags.filter((t) => t.dimension === "content"),
          confirmed = tags.filter((t) => t.isConfirmed),
          codes = [...new Set((confirmed.length ? confirmed : tags).map((t) => t.tagCode))];
        return {
          storeAssetId: r.id,
          type: r.type,
          title: r.title,
          contentTags: await dicts(tx, "asset_tag", codes),
        };
      }),
    );
    const refs = await tx.fileRef.findMany({
      where: { refType: "drama_order", refId: p.dramaOrderId, role: "reference", state: "live" },
    });
    const usages = await tx.storeAssetUsage.findMany({
      where: { usedByType: "drama_order", usedById: p.dramaOrderId, role: "reference" },
      include: { storeAsset: { include: { storeAssetFiles: true } } },
    });
    const assetFiles = new Set(
      usages.flatMap((u) => u.storeAsset.storeAssetFiles.map((f) => f.fileId)),
    );
    const media = await tx.storeProfileMedia.findMany({
      where: {
        storeId: p.storeId,
        fileId: { in: refs.filter((r) => !assetFiles.has(r.fileId)).map((r) => r.fileId) },
      },
    });
    const profileMedia = [
      ...new Map(
        media.map((r) => [
          r.fileId,
          { fileId: r.fileId, mediaGroup: r.mediaGroup, type: r.mediaKind },
        ]),
      ).values(),
    ];
    const items = await Promise.all(
      content.items.map(async (row) => {
        const item = p.dramaOrder.orderItems.find((i) => i.id === row.orderItemId)!,
          base = await planItem(tx, p, row),
          shot = snapshot(item.dramaSnapshot);
        if (shot.posterFileId) posters[row.orderItemId] = shot.posterFileId;
        const placements = await Promise.all(
          base.placements.map(async (a) => {
            const ad = await tx.ad.findUniqueOrThrow({
              where: { id: a.adId },
              include: { adVersions: true, adRevisions: { where: { fulfilledByVersionNo: null } } },
            });
            const display = ["pending_assign", "producing", "returned"].includes(ad.status)
              ? "producing"
              : ad.status;
            return {
              slot: a.slot,
              durationSec: a.durationSec,
              adId: a.adId,
              adNo: a.adNo,
              adDisplayStatus: display,
              adCopy: ad.copy,
              latestVersionNo: ad.latestVersionNo,
              nextVersionNo: ["producing", "revising"].includes(display)
                ? Math.max(
                    0,
                    ...ad.adVersions.filter((r) => r.pushedAt !== null).map((r) => r.versionNo),
                  ) + 1
                : null,
              openRevisionRequestedAt: iso(ad.adRevisions[0]?.createdAt ?? null),
              confirmedVersionNo: ad.confirmedVersionNo,
              confirmedAt: iso(ad.confirmedAt),
              dueAt: iso(ad.dueAt),
            };
          }),
        );
        return {
          orderItemId: row.orderItemId,
          dramaTitle: base.dramaTitle,
          genres: await dicts(tx, "genre", shot.genreCodes ?? []),
          posterUrl: null as { url: string; expiresAt: string } | null,
          episodeCount: item.episodeCount,
          usageEndDate: dateOf(item.usageEndDate),
          productionModel: item.productionModel,
          accounts: base.accounts,
          placements,
          agreedLaunchDate: row.agreedLaunchDate,
          expectedDeliveryDate: row.expectedDeliveryDate,
        };
      }),
    );
    view = {
      focusTags: content.focusTags,
      referenceAssets,
      profileMedia,
      note: content.note,
      launchMode: content.launchMode,
      items,
    };
  }
  const open = p.deliveryPlanChangeRequests.filter((r) => r.resolvedByVersionNo === null).reverse(),
    kinds = ["launch_date", "account", "customization", "placement", "ad", "other"].filter((k) =>
      open.some((r) => r.kinds.includes(k)),
    );
  const manager = p.dramaOrder.deliveryManager;
  return {
    posters,
    data: {
      deliveryPlanId: p.id,
      orderId: p.dramaOrderId,
      orderNo: p.dramaOrder.orderNo,
      planCode: p.dramaOrder.planCode,
      status: p.status,
      currentVersionNo: p.currentVersionNo,
      confirmedVersionNo: p.confirmedVersionNo,
      confirmedAt: iso(p.confirmedAt),
      staffDueAt: iso(p.staffDueAt),
      isOrderInAfterSale: !!p.dramaOrder.openCancelRequestId,
      deliveryManagerName: manager?.displayName ?? manager?.name ?? null,
      version: v
        ? {
            versionNo: v.versionNo,
            pushedAt: iso(v.pushedAt),
            pushedByName: v.pushedByStaff.displayName ?? v.pushedByStaff.name,
            changeSummary: v.changeSummary,
            decision: v.decision,
            decidedAt: iso(v.decidedAt),
          }
        : null,
      content: view,
      itemCount: content?.items.length ?? 0,
      totalEpisodes: content
        ? p.dramaOrder.orderItems
            .filter((r) => content.items.some((i) => i.orderItemId === r.id))
            .reduce((s, r) => s + r.episodeCount, 0)
        : 0,
      openChange: p.status === "revising" ? { kinds, notes: open.map((r) => r.note) } : null,
      changeRequests: p.deliveryPlanChangeRequests.map(change),
      actions:
        p.store.lifecycle !== "active" || p.dramaOrder.openCancelRequestId
          ? []
          : p.status === "pending_confirm"
            ? ["confirm", "request-change"]
            : p.status === "revising"
              ? ["request-change"]
              : [],
    },
  };
}
export async function signPlan(
  deps: DeliveryDeps,
  raw: Awaited<ReturnType<typeof merchantPlanView>>,
  replayed = false,
) {
  if (!replayed && raw.data.content)
    for (const item of raw.data.content.items) {
      const fileId = raw.posters[item.orderItemId];
      if (fileId) item.posterUrl = await deps.media.signRead({ fileId, audience: "merchant" });
    }
  return raw.data;
}
export function urgency(t: TicketRow, now: Date) {
  const today = calendarDate(now),
    launch = ["awaiting_launch", "launch_verify"].includes(t.step)
      ? dateOf(t.orderItem.agreedLaunchDate)
      : null;
  if ((t.stepDueAt && t.stepDueAt < now) || (launch && launch < today)) return "overdue";
  if ((t.stepDueAt && calendarDate(t.stepDueAt) === today) || launch === today) return "due_today";
  return "normal";
}
export async function ticketCard(tx: Tx, t: TicketRow, staff: StaffContext, now: Date) {
  return {
    deliveryTicketId: t.id,
    ticketNo: t.ticketNo,
    step: t.step,
    stepEnteredAt: iso(t.stepEnteredAt),
    stepDueAt: iso(t.stepDueAt),
    waitingOn: t.waitingOn,
    urgency: urgency(t, now),
    isPaused: t.pauseCount > 0,
    pauseReasons: t.deliveryTicketPauses.map((r) => r.reason),
    isStuck:
      (await tx.invariantViolation.count({
        where: {
          code: "flow.STUCK_TICKET",
          subjectType: "delivery_ticket",
          subjectId: t.id,
          resolvedAt: null,
        },
      })) > 0,
    store: await storeView(tx, t.store),
    order: { orderId: t.dramaOrderId, orderNo: t.dramaOrder.orderNo },
    orderItemId: t.orderItemId,
    dramaTitle: snapshot(t.orderItem.dramaSnapshot).title ?? "",
    episodeCount: t.orderItem.episodeCount,
    productionModel: t.orderItem.productionModel,
    platforms: t.orderItem.orderItemAccounts.map((r) => r.platform),
    agreedLaunchDate: dateOf(t.orderItem.agreedLaunchDate),
    usageEndDate: dateOf(t.orderItem.usageEndDate),
    schedulePriority: t.schedulePriority,
    deliveryManager: await brief(tx, t.deliveryManagerId),
    editor: await brief(tx, t.editorId),
    publisher: await brief(tx, t.publisherId),
    deliveryTargetAt: iso(t.deliveryTargetAt),
    deliveredAt: iso(t.deliveredAt),
    createdAt: iso(t.createdAt),
    actions:
      t.step === "assigning" &&
      t.pauseCount === 0 &&
      staff.staff.isLead &&
      hasPermission(staff, "merchant.manager.assign")
        ? ["assign-manager"]
        : [],
  };
}
async function qcView(tx: Tx, r: QcRecord | null) {
  if (!r) return null;
  const template = await tx.checklistTemplate.findUnique({
    where: { code_versionNo: { code: r.checklistCode, versionNo: r.checklistVersionNo } },
  });
  const defs = template ? ChecklistItemsSchema.parse(template.items) : [],
    results = r.results as Array<{ key: string; result: string; note?: string }>;
  return {
    qcRecordId: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    checklistCode: r.checklistCode,
    checklistVersionNo: r.checklistVersionNo,
    verdict: r.verdict,
    rejectReason: r.rejectReason,
    items: results.map((i) => ({
      ...i,
      label: defs.find((d) => d.key === i.key)?.label ?? i.key,
      note: i.note ?? null,
      merchantVisible: defs.find((d) => d.key === i.key)?.merchantVisible ?? false,
    })),
    inspectedBy: (await brief(tx, r.inspectedByStaffId))!,
    inspectedAt: iso(r.inspectedAt),
  };
}
export async function ticketDetail(tx: Tx, t: TicketRow, staff: StaffContext, now: Date) {
  const card = await ticketCard(tx, t, staff, now),
    item = t.orderItem,
    shot = snapshot(item.dramaSnapshot),
    p = t.dramaOrder.deliveryPlan;
  const v = p?.deliveryPlanVersions.find(
      (r) => r.versionNo === (p.confirmedVersionNo ?? p.currentVersionNo),
    ),
    content = v ? PlanContentSchema.parse(v.contentSnapshot) : null,
    row = content?.items.find((r) => r.orderItemId === item.id);
  const owner = await tx.entityMember.findFirst({
    where: { entityId: t.entityId, role: "owner", removedAt: null },
  });
  const profile = t.store.storeProfileStore;
  const milestones = {
    assignedAt: iso(t.assignedAt),
    planConfirmedAt: iso(t.planConfirmedAt),
    adsReadyAt: iso(t.adsReadyAt),
    sampleFirstPushedAt: iso(t.sampleFirstPushedAt),
    sampleConfirmedAt: iso(t.sampleConfirmedAt),
    composedAt: iso(t.composedAt),
    deliveredAt: iso(t.deliveredAt),
    linksSubmittedAt: iso(t.linksSubmittedAt),
    liveAt: iso(t.liveAt),
    usageEndedAt: iso(t.usageEndedAt),
    archivedAt: iso(t.archivedAt),
    terminatedAt: iso(t.terminatedAt),
  };
  const tasks = t.launchTasks.map((r) => ({
    launchTaskId: r.id,
    channelAccountId: r.channelAccountId,
    platform: r.channelAccount.platform,
    accountName: r.channelAccount.accountName,
    reviewStatus: r.reviewStatus,
    isLive: r.isLive,
    currentRoundNo: r.currentRoundNo,
    currentLaunchSubmissionId:
      r.launchSubmissions.find((s) => s.roundNo === r.currentRoundNo)?.id ?? null,
  }));
  return {
    ...card,
    pauses: t.deliveryTicketPauses.map((r) => ({
      reason: r.reason,
      refType: r.refType,
      refId: r.refId,
      actorType: r.actorType,
      createdAt: iso(r.createdAt),
    })),
    pausedAt: iso(t.pausedAt),
    pauseRemainingMin: t.pauseRemainingMin,
    sampleRoundNo: t.sampleRoundNo,
    currentSampleVersionNo: t.currentSampleVersionNo,
    milestones,
    stages: t.deliveryTicketStages.map((r) => ({
      step: r.step,
      visitNo: r.visitNo,
      enteredAt: iso(r.enteredAt),
      dueAt: iso(r.dueAt),
      completedAt: iso(r.completedAt),
      exitEvent: r.exitEvent,
      pausedMinutes: r.pausedMinutes,
      isBreached: r.isBreached,
    })),
    lockVersion: t.lockVersion,
    orderItem: {
      orderItemId: item.id,
      itemNo: item.itemNo,
      dramaId: item.dramaId,
      dramaTitle: shot.title ?? "",
      genres: await dicts(tx, "genre", shot.genreCodes ?? []),
      episodeCount: item.episodeCount,
      productionModel: item.productionModel,
      listPricePoints: item.listPricePoints,
      discountBp: item.discountBp,
      surchargeBp: item.surchargeBp,
      chargePoints: item.chargePoints,
      phase: item.phase,
      phaseChangedAt: iso(item.phaseChangedAt),
      capturedAt: iso(item.capturedAt),
      agreedLaunchDate: dateOf(item.agreedLaunchDate),
      usageStartDate: dateOf(item.usageStartDate),
      usageEndDate: dateOf(item.usageEndDate),
      usageEndSource: item.usageEndSource,
      liveEpisodeCount: item.liveEpisodeCount,
      accounts: item.orderItemAccounts.map((r) => account(r.channelAccount)),
      placements: item.orderItemPlacements.map((r) => ({
        slot: r.slot,
        adId: r.adId,
        adNo: r.ad.adNo,
        durationSec: r.durationSec,
        boundVersionNo: r.boundVersionNo,
        pinnedAt: iso(r.pinnedAt),
      })),
      refundRequestedPoints: item.refundRequestedPoints,
      returnedPoints: item.returnedPoints,
      convertedPoints: item.convertedPoints,
      forfeitedPoints: item.forfeitedPoints,
      cancelReasonCode: item.cancelReasonCode,
      cancelledAt: iso(item.cancelledAt),
      ticket: null,
      pointHold: {
        pointHoldId: item.pointHold.id,
        status: item.pointHold.status,
        heldAt: iso(item.pointHold.heldAt),
        capturedAt: iso(item.pointHold.capturedAt),
      },
    },
    order: {
      orderId: t.dramaOrderId,
      orderNo: t.dramaOrder.orderNo,
      submittedAt: iso(t.dramaOrder.submittedAt),
      totalChargePoints: t.dramaOrder.totalChargePoints,
      itemCount: t.dramaOrder.itemCount,
      status: t.dramaOrder.status,
      siblings: t.dramaOrder.deliveryTickets
        .filter((r) => r.id !== t.id)
        .map((r) => ({
          deliveryTicketId: r.id,
          ticketNo: r.ticketNo,
          dramaTitle: snapshot(r.orderItem.dramaSnapshot).title ?? "",
          step: r.step,
        })),
    },
    merchant: {
      store: card.store,
      province: await dict(tx, "region", profile?.provinceCode ?? null),
      industry: await dict(tx, "industry", profile?.industryCode ?? null),
      category: await dict(tx, "industry", profile?.categoryCode ?? null),
      contactName: profile?.contactName ?? null,
      contactPhoneMask: profile?.contactPhoneMask ?? null,
      isWecomAdded:
        !!owner &&
        !!t.deliveryManagerId &&
        (await tx.wecomContact.count({
          where: {
            merchantUserId: owner.merchantUserId,
            staffId: t.deliveryManagerId,
            removedAt: null,
          },
        })) > 0,
    },
    plan: p
      ? {
          deliveryPlanId: p.id,
          status: p.status,
          currentVersionNo: p.currentVersionNo,
          confirmedVersionNo: p.confirmedVersionNo,
          pushedAt: iso(p.pushedAt),
          pushedBy: v ? await brief(tx, v.pushedByStaffId) : null,
          confirmedAt: iso(p.confirmedAt),
          item: row ? await planItem(tx, p, row) : null,
        }
      : null,
    // PR2 落地样片、成片包写侧时补聚合；PR1 的生产主链尚未生成这些产物。
    ads: [],
    currentSample: null,
    samples: [],
    episodeProgress: {
      totalEpisodes: item.episodeCount,
      currentPassedCount: t.episodeOutputs.filter((r) => r.status === "qc_passed").length,
      uploadedCount: t.episodeOutputs.length,
      rejectedCount: t.episodeOutputs.filter((r) =>
        ["qc_rejected", "check_rejected"].includes(r.status),
      ).length,
      packageQc: await qcView(
        tx,
        t.qcRecords.find((r) => r.targetType === "delivery_ticket") ?? null,
      ),
    },
    release: null,
    openReissue: null,
    openUploadBatches: [],
    publishList: null,
    launch: {
      taskCount: tasks.length,
      liveCount: tasks.filter((r) => r.isLive).length,
      verifyingCount: tasks.filter((r) => r.reviewStatus === "verifying").length,
      needFixCount: tasks.filter((r) => r.reviewStatus === "need_fix").length,
      pendingCount: tasks.filter((r) => r.reviewStatus === "pending").length,
      tasks,
    },
    remindScenes: [],
  };
}
