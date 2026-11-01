import {
  AdTaskCardSchema,
  AdTaskDetailSchema,
  AdminAdVersionViewSchema,
  AdminAdRevisionViewSchema,
  AdSummarySchema,
} from "@liyoxi/contract";
import type { AdminAdFilters, AdminAdListQuery, z } from "@liyoxi/contract";
import type { Ad, Prisma } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { assertAccess, hasPermission, taskScope, scopeSnapshot } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import { storeGate, readMaterialProfile } from "../profile/index.js";
import { readAdReferenceFacts, readMaterialFileFacts } from "../media/index.js";
import { staffBriefs, readCurrentStaffContext } from "../staff/index.js";
import type { AdStaffActor, AdWriteDeps } from "./context.js";

type Detail = z.infer<typeof AdTaskDetailSchema>;
export interface AdAdminRelations {
  store: Detail["store"];
  deliveryManagerId: string | null;
  planName: string | null;
  pointHold: Detail["pointHold"];
  agreement: Detail["agreement"];
  cancelRequests: Detail["cancelRequests"];
  usages: Detail["usages"];
  serviceTickets: Detail["serviceTickets"];
}
export type AdAdminTarget = Pick<
  Ad,
  "id" | "entityId" | "storeId" | "pointHoldId" | "agreementConsentId" | "pricingSnapshot"
>;
export interface AdAdminReadDeps extends AdWriteDeps {
  relations(tx: Tx, actor: AdStaffActor, ad: AdAdminTarget): Promise<AdAdminRelations>;
}
const iso = (value: Date | null) => value?.toISOString() ?? null;
const active = ["pending_assign", "producing", "revising"];
const signingPlans = new WeakMap<
  object,
  {
    screenshots: ReadonlyMap<string, readonly string[]>;
    thumbnails: ReadonlyMap<string, string | null>;
    posters: ReadonlyMap<string, string | null>;
  }
>();
export function assertAdStaff(
  actor: AdStaffActor,
  permission: Parameters<typeof assertAccess>[1]["permission"] = null,
  edit = false,
) {
  if (actor.ctx.actor.type !== "staff" || actor.ctx.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertAccess(actor.staff, {
    module: { module: "delivery", need: edit ? "edit" : "view" },
    permission,
  });
}
/** The full staff20 set is already held; a changed grant must start a fresh request/lock graph. */
export async function assertCurrentAdStaff(tx: Tx, actor: AdStaffActor) {
  const current = await readCurrentStaffContext(tx, actor.staff);
  const signature = (staff: AdStaffActor["staff"]) =>
    JSON.stringify({
      staff: staff.staff,
      levels: staff.moduleLevels,
      permissions: [...staff.permissions].sort(),
      scope: scopeSnapshot(staff.scope),
    });
  if (signature(current) !== signature(actor.staff)) throw new AppError("PERMISSION_DENIED");
  assertAdStaff({ ...actor, staff: current });
}
export function adAdminScope(actor: AdStaffActor): Prisma.AdWhereInput {
  assertAdStaff(actor);
  return {
    ...taskScope<Prisma.AdWhereInput>(actor.staff.scope, {
      store: (store) => ({ store }),
      assignees: [{ col: "editorId", pool: "ad_editor" }],
    }),
    ...(actor.staff.moduleLevels.delivery === "o" ? { editorId: actor.staff.staff.id } : {}),
  };
}
export async function adAdminTarget(tx: Tx, actor: AdStaffActor, id: string) {
  const ad = await tx.ad.findFirst({ where: { AND: [{ id }, adAdminScope(actor)] } });
  if (!ad) throw new AppError("NOT_FOUND");
  return ad;
}
export async function adAdminVersionParent(tx: Tx, actor: AdStaffActor, id: string) {
  const version = await tx.adVersion.findUnique({ where: { id }, select: { adId: true } });
  if (!version) throw new AppError("NOT_FOUND");
  await adAdminTarget(tx, actor, version.adId);
  return version.adId;
}
export async function adAdminWhere(tx: Tx, actor: AdStaffActor, q: AdminAdFilters, now: Date) {
  const where: Prisma.AdWhereInput[] = [adAdminScope(actor)];
  if (q.q)
    where.push({
      OR: [
        { adNo: { contains: q.q, mode: "insensitive" } },
        { store: { name: { contains: q.q, mode: "insensitive" } } },
      ],
    });
  if (q.storeId) where.push({ storeId: q.storeId });
  if (q.entityId) where.push({ entityId: q.entityId });
  if (q.type) where.push({ type: q.type });
  if (q.editorId) where.push({ editorId: q.editorId === "none" ? null : q.editorId });
  if (q.overdueOnly) where.push({ status: { in: active }, dueAt: { lt: now } });
  if (q.isWaitingQualification)
    where.push({
      status: "pending_assign",
      OR: [
        { store: { qualificationStatus: { not: "verified" } } },
        { store: { lifecycle: { not: "active" } } },
        { store: { entity: { lifecycle: { not: "active" } } } },
      ],
    });
  if (q.isReturnedStale) {
    const days = (await paramsAt(tx, ["ad.returned_stale_days"], now))["ad.returned_stale_days"];
    where.push({
      status: "returned",
      returnedAt: { lte: new Date(now.getTime() - days * 86_400_000) },
    });
  }
  return { AND: where } satisfies Prisma.AdWhereInput;
}
export function canRemindAd(
  actor: AdStaffActor,
  ad: Pick<Ad, "editorId">,
  managerId: string | null,
) {
  // Same supervisor/super-admin convention as the existing delivery manual-reminder use case.
  return (
    ad.editorId === actor.staff.staff.id ||
    managerId === actor.staff.staff.id ||
    actor.staff.staff.isLead ||
    actor.staff.staff.roleKey === "super_admin"
  );
}
async function actions(tx: Tx, actor: AdStaffActor, ad: Ad, managerId: string | null, now: Date) {
  if (ad.openCancelRequestId || ad.status === "cancelled") return [];
  const result: string[] = [],
    own = ad.editorId === actor.staff.staff.id;
  if (ad.status === "pending_assign" && hasPermission(actor.staff, "delivery.ad.assign"))
    result.push("assign");
  if (
    ["pending_assign", "producing"].includes(ad.status) &&
    hasPermission(actor.staff, "delivery.ad.return")
  )
    result.push("return");
  if (
    ["producing", "revising"].includes(ad.status) &&
    own &&
    hasPermission(actor.staff, "delivery.ad.upload")
  )
    result.push("create-version");
  if (
    ad.status === "pending_confirm" &&
    canRemindAd(actor, ad, managerId) &&
    !(await tx.manualReminderLog.count({
      where: {
        subjectType: "ad",
        subjectId: ad.id,
        scene: "confirm_ad",
        bizDate: new Date(calendarDate(now)),
      },
    }))
  )
    result.push("remind");
  if (
    ["pending_confirm", "confirmed"].includes(ad.status) &&
    ad.revisionCount < ad.freeRevisionQuota &&
    hasPermission(actor.staff, "delivery.sample.feedback_on_behalf")
  )
    result.push("request-change");
  if (
    !["confirmed", "cancelled"].includes(ad.status) &&
    hasPermission(actor.staff, "order.refund.request")
  )
    result.push("cancel");
  return result;
}
async function card(tx: Tx, deps: AdAdminReadDeps, actor: AdStaffActor, ad: Ad) {
  const facts = await deps.relations(tx, actor, ad),
    now = deps.clock.now();
  const editor = ad.editorId ? ((await staffBriefs(tx, [ad.editorId]))[0] ?? null) : null;
  const pending = facts.cancelRequests.find((r) => r.cancelRequestId === ad.openCancelRequestId);
  return AdTaskCardSchema.parse({
    adId: ad.id,
    adNo: ad.adNo,
    store: facts.store,
    planName: facts.planName,
    type: ad.type,
    durationSec: ad.durationSec,
    status: ad.status,
    isWaitingQualification:
      ad.status === "pending_assign" && (await storeGate(tx, ad.storeId)) !== "full",
    editor,
    chargePoints: ad.chargePoints,
    isCaptured: !!ad.capturedAt,
    submittedAt: iso(ad.submittedAt),
    dueAt: iso(ad.dueAt),
    firstDueAt: iso(ad.firstDueAt),
    isFirstBreached: !!ad.firstBreachedAt,
    urgency:
      ad.dueAt && ad.dueAt < now
        ? "overdue"
        : ad.dueAt && calendarDate(ad.dueAt) === calendarDate(now)
          ? "due_today"
          : "normal",
    latestVersionNo: ad.latestVersionNo,
    confirmedVersionNo: ad.confirmedVersionNo,
    revisionCount: ad.revisionCount,
    freeRevisionQuota: ad.freeRevisionQuota,
    openCancelRequest: pending
      ? {
          cancelRequestId: pending.cancelRequestId,
          requestNo: pending.requestNo,
          status: pending.status,
          totalRefundPoints: pending.totalRefundPoints,
        }
      : null,
    linkedTicketNos: [...new Set(facts.usages.flatMap((r) => (r.ticketNo ? [r.ticketNo] : [])))],
    actions: await actions(tx, actor, ad, facts.deliveryManagerId, now),
  });
}
export async function listAdminAds(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  q: AdminAdListQuery,
) {
  const base = await adAdminWhere(tx, actor, q, deps.clock.now());
  const where: Prisma.AdWhereInput = {
    AND: [
      base,
      ...(q.tab === "all"
        ? []
        : [q.tab === "todo" ? { status: { in: active } } : { status: q.tab }]),
    ],
  };
  const total = await tx.ad.count({ where });
  const rows = await tx.ad.findMany({
    where,
    orderBy:
      q.sort === "-submittedAt"
        ? [{ submittedAt: "desc" }, { id: "desc" }]
        : [{ dueAt: { sort: "asc", nulls: "last" } }, { submittedAt: "asc" }, { id: "asc" }],
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize,
  });
  const items = [];
  for (const ad of rows) items.push(await card(tx, deps, actor, ad));
  return { items, page: q.page, pageSize: q.pageSize, total };
}
export async function summaryAdminAds(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  q: AdminAdFilters,
) {
  const now = deps.clock.now(),
    base = await adAdminWhere(tx, actor, q, now);
  const counts = await tx.ad.groupBy({ by: ["status"], where: base, _count: true });
  const count = (...statuses: string[]) =>
    counts.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r._count, 0);
  return AdSummarySchema.parse({
    tabs: {
      todo: count(...active),
      pending_confirm: count("pending_confirm"),
      confirmed: count("confirmed"),
      returned: count("returned"),
      cancelled: count("cancelled"),
    },
    overdueCount: await tx.ad.count({
      where: { AND: [base, { status: { in: active }, dueAt: { lt: now } }] },
    }),
    waitingQualificationCount: await tx.ad.count({
      where: await adAdminWhere(tx, actor, { ...q, isWaitingQualification: true }, now),
    }),
  });
}
export async function adminVersionView(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  id: string,
) {
  const version = await tx.adVersion.findUnique({ where: { id } });
  if (!version) throw new AppError("NOT_FOUND");
  const ad = await adAdminTarget(tx, actor, version.adId);
  const people = await staffBriefs(tx, [
    version.uploadedByStaffId,
    ...(version.offlineSentByStaffId ? [version.offlineSentByStaffId] : []),
  ]);
  const uploader = people.find((r) => r.staffId === version.uploadedByStaffId);
  if (!uploader) throw new AppError("PRECONDITION_CHANGED");
  const actual = await deps.media.adProductionFacts(tx, version.fileId);
  const usable = ad.status !== "cancelled" && !ad.openCancelRequestId && version.decision === null;
  return AdminAdVersionViewSchema.parse({
    adVersionId: id,
    versionNo: version.versionNo,
    fileId: version.fileId,
    durationMs: version.durationMs,
    width: version.width,
    height: version.height,
    segments: version.segments ?? [],
    uploadedBy: uploader,
    uploadedAt: iso(version.uploadedAt),
    production:
      actual.production && actual.softWarnCount !== null
        ? {
            pipelineState: actual.production.pipelineState,
            gate: actual.gate,
            softWarnCount: actual.softWarnCount,
            aigcState: actual.production.aigcState,
          }
        : null,
    pushedAt: iso(version.pushedAt),
    previewChannels: version.previewChannels,
    offlineSentAt: iso(version.offlineSentAt),
    offlineSentBy: people.find((r) => r.staffId === version.offlineSentByStaffId) ?? null,
    decision: version.decision,
    decidedAt: iso(version.decidedAt),
    viewedVia: version.confirmViewedVia,
    viewedAckAt: iso(version.viewedAckAt),
    preview: null,
    actions: usable
      ? [
          ...(!version.offlineSentAt && hasPermission(actor.staff, "delivery.sample.push")
            ? ["mark-sent"]
            : []),
          ...(!version.pushedAt &&
          version.versionNo === ad.latestVersionNo &&
          ["producing", "revising"].includes(ad.status) &&
          ad.editorId === actor.staff.staff.id &&
          hasPermission(actor.staff, "delivery.ad.upload")
            ? ["push"]
            : []),
        ]
      : [],
  });
}
export async function detailAdminAd(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  id: string,
) {
  const ad = await adAdminTarget(tx, actor, id),
    base = await card(tx, deps, actor, ad),
    facts = await deps.relations(tx, actor, ad);
  const versions = await tx.adVersion.findMany({
    where: { adId: id },
    orderBy: { versionNo: "desc" },
  });
  const revisions = await tx.adRevision.findMany({
    where: { adId: id },
    orderBy: { revisionNo: "desc" },
  });
  const refs = await readAdReferenceFacts(tx, {
    entityId: ad.entityId,
    storeId: ad.storeId,
    adId: id,
  });
  const files = await readMaterialFileFacts(tx, [
    ...refs.profileFileIds,
    ...refs.assets.flatMap((r) => r.storeAssetFiles.map((f) => f.fileId)),
    ...versions.map((r) => r.fileId),
  ]);
  const profile = await readMaterialProfile(tx, {
    entityId: ad.entityId,
    storeId: ad.storeId,
    fileIds: refs.profileFileIds,
  });
  const people = await staffBriefs(
    tx,
    revisions.flatMap((r) => (r.actorType === "staff" && r.actorId ? [r.actorId] : [])),
  );
  const logs = await tx.auditLog.findMany({
    where: {
      OR: [
        { targetType: "ad", targetId: id },
        { targetType: "ad_version", targetId: { in: versions.map((r) => r.id) } },
        { targetType: "ad_revision", targetId: { in: revisions.map((r) => r.id) } },
      ],
      stream: { in: ["ops", "activity"] },
    },
    orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
    take: 50,
  });
  const requestIds = logs.flatMap((r) => (r.requestId ? [r.requestId] : []));
  const transitions = requestIds.length
    ? await tx.statusTransition.findMany({
        where: { machine: "ad", subjectId: id, requestId: { in: requestIds } },
        orderBy: { seq: "desc" },
      })
    : [];
  const promo = await tx.dictItem.findMany({
    where: { dictTypeKey: "ad_promo_point", code: { in: ad.promoPointCodes } },
    select: { code: true, name: true },
  });
  const views = [];
  for (const v of versions) views.push(await adminVersionView(tx, deps, actor, v.id));
  const value = AdTaskDetailSchema.parse({
    ...base,
    promoPoints: ad.promoPointCodes.map(
      (code) => promo.find((r) => r.code === code) ?? { code, name: code },
    ),
    copy: ad.copy,
    remark: ad.remark,
    referenceFiles: [
      ...refs.assets.flatMap((asset) =>
        asset.storeAssetFiles.map(({ fileId }) => ({
          fileId,
          source: "store_asset",
          storeAssetId: asset.id,
          title: asset.title,
          usability: asset.usability,
          mediaGroup: null,
          type: asset.type,
          thumbnail: null,
        })),
      ),
      ...refs.profileFileIds.map((fileId) => ({
        fileId,
        source: "profile_media",
        storeAssetId: null,
        title: null,
        usability: null,
        mediaGroup: profile.media.find((r) => r.fileId === fileId)?.mediaGroup ?? null,
        type: files.find((r) => r.id === fileId)?.category ?? "profile_media",
        thumbnail: null,
      })),
    ],
    returnedFrom: ad.returnedFrom,
    returnedAt: iso(ad.returnedAt),
    returnReason: ad.returnReason,
    resubmitCount: ad.resubmitCount,
    pricing: {
      unitPricePoints: ad.unitPricePoints,
      discountBp: ad.discountBp,
      chargePoints: ad.chargePoints,
      freeRevisionQuota: ad.freeRevisionQuota,
    },
    pointHold: facts.pointHold,
    refunds: {
      refundRequestedPoints: ad.refundRequestedPoints,
      returnedPoints: ad.returnedPoints,
      convertedPoints: ad.convertedPoints,
      forfeitedPoints: ad.forfeitedPoints,
    },
    capturedAt: iso(ad.capturedAt),
    confirmedAt: iso(ad.confirmedAt),
    cancelReasonCode: ad.cancelReasonCode,
    cancelledAt: iso(ad.cancelledAt),
    versions: views,
    revisions: revisions.map((r) =>
      AdminAdRevisionViewSchema.parse({
        adRevisionId: r.id,
        revisionNo: r.revisionNo,
        onVersionNo: r.onVersionNo,
        source: r.source,
        isChargeable: r.isChargeable,
        chargePoints: r.chargePoints,
        note: r.note,
        segmentIndex: r.segmentIndex,
        timeStartMs: r.timeStartMs,
        timeEndMs: r.timeEndMs,
        screenshots: r.screenshotFileIds.length ? null : [],
        actorType: r.actorType,
        actorName: people.find((p) => p.staffId === r.actorId)?.name ?? null,
        client: r.client,
        dueAt: iso(r.dueAt),
        breachedAt: iso(r.breachedAt),
        fulfilledByVersionNo: r.fulfilledByVersionNo,
        createdAt: iso(r.createdAt),
      }),
    ),
    usages: facts.usages,
    agreement: facts.agreement,
    cancelRequests: facts.cancelRequests,
    serviceTickets: facts.serviceTickets,
    recentActivities: logs.map((r) => {
      const transition =
        r.requestId && r.targetType === "ad"
          ? transitions.find(
              (t) =>
                t.requestId === r.requestId &&
                r.action === `ad.status.${t.event.replace(/^ad\./, "")}`,
            )
          : undefined;
      return {
        activityId: r.id,
        occurredAt: iso(r.createdAt),
        actorType: r.actorType,
        actorName: r.actorName,
        actorRole: r.actorRole,
        client: r.client,
        action: r.action,
        summary: r.summary,
        targetType: r.targetType,
        targetId: r.targetId,
        targetLabel: r.targetLabel,
        reasonText: r.reasonText,
        transition: transition
          ? {
              machine: transition.machine,
              stateField: transition.stateField,
              fromState: transition.fromState,
              toState: transition.toState,
              event: transition.event,
              isForced: transition.isForced,
            }
          : null,
      };
    }),
    lockVersion: ad.lockVersion,
  });
  signingPlans.set(value, {
    screenshots: new Map(revisions.map((r) => [r.id, r.screenshotFileIds])),
    thumbnails: new Map(
      value.referenceFiles.map((r) => {
        const file = files.find((f) => f.id === r.fileId);
        return [
          r.fileId,
          file?.mediaInfo?.coverFileId ??
            (file && ["jpg", "jpeg", "png"].includes(file.ext) ? file.id : null),
        ];
      }),
    ),
    posters: new Map(
      versions.map((r) => [
        r.id,
        files.find((f) => f.id === r.fileId)?.mediaInfo?.coverFileId ?? null,
      ]),
    ),
  });
  return value;
}

/** GET signatures are outside TX; no URL or private signing plan is persisted in idempotency results. */
export async function signAdminAdDetail(deps: AdAdminReadDeps, value: Detail) {
  const plan = signingPlans.get(value);
  if (!plan) return value;
  for (const version of value.versions) {
    try {
      const signed = await deps.media.signRead({ fileId: version.fileId, audience: "staff" });
      const poster = plan.posters.get(version.adVersionId);
      version.preview = {
        url: signed.url,
        expiresAt: signed.expiresAt,
        posterUrl: poster
          ? (await deps.media.signRead({ fileId: poster, audience: "staff" })).url
          : null,
      };
    } catch (error) {
      if (!(
        error instanceof AppError &&
        ["FILE_NOT_USABLE", "NOT_FOUND", "FILE_NOT_AVAILABLE"].includes(error.error)
      ))
        throw error;
    }
  }
  for (const revision of value.revisions) {
    const files = plan.screenshots.get(revision.adRevisionId) ?? [];
    revision.screenshots = await Promise.all(
      files.map(async (fileId) => ({
        fileId,
        ...(await deps.media.signRead({ fileId, audience: "staff" })),
      })),
    );
  }
  for (const reference of value.referenceFiles) {
    const thumbnail = plan.thumbnails.get(reference.fileId);
    if (thumbnail)
      reference.thumbnail = await deps.media.signRead({ fileId: thumbnail, audience: "staff" });
  }
  return value;
}
