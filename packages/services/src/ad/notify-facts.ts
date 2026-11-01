import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import type { TransactionConsentFact, Tx } from "../kernel/index.js";
import { decideAccess, taskScope } from "../authz/index.js";
import type { Prisma } from "@liyoxi/db";
import { readAdTaskStore } from "../profile/index.js";
import { staffContextsForNotify } from "../staff/index.js";

/** Current ad and current pushed version; a delayed request cannot borrow a later push. */
export async function adVersionForNotify(
  tx: Tx,
  adId: string,
  boundary?: { eventId: string; manualReminderLogId: string },
) {
  const ad = await tx.ad.findUnique({
    where: { id: adId },
    include: { store: { include: { entity: true } } },
  });
  if (
    !ad ||
    ad.status !== "pending_confirm" ||
    ad.openCancelRequestId ||
    ad.store.lifecycle !== "active" ||
    ad.store.entity.lifecycle !== "active"
  )
    return null;
  const version = await tx.adVersion.findFirst({
    where: { adId, versionNo: ad.latestVersionNo, pushedAt: { not: null }, decision: null },
  });
  if (!version) return null;
  if (boundary) {
    const event = await tx.outboxEvent.findUnique({ where: { id: boundary.eventId } });
    if (
      !event ||
      event.eventType !== "manual_reminder.sent" ||
      event.entityId !== ad.entityId ||
      event.storeId !== ad.storeId
    )
      return null;
    const payload = EVENT_PAYLOAD_SCHEMAS["manual_reminder.sent"].safeParse(event.payload);
    if (
      !payload.success ||
      payload.data.subjectType !== "ad" ||
      payload.data.subjectId !== ad.id ||
      payload.data.scene !== "confirm_ad" ||
      payload.data.manualReminderLogId !== boundary.manualReminderLogId ||
      event.aggregateType !== "manual_reminder_log" ||
      event.aggregateId !== payload.data.manualReminderLogId
    )
      return null;
    const pushed = await tx.outboxEvent.findFirst({
      where: {
        eventType: "ad.version_pushed",
        aggregateType: "ad",
        aggregateId: ad.id,
        entityId: ad.entityId,
        storeId: ad.storeId,
        payload: { path: ["versionNo"], equals: version.versionNo },
      },
      orderBy: { seq: "desc" },
    });
    // seq also distinguishes same-clock commits, unlike a timestamp-only comparison.
    if (!pushed || pushed.seq >= event.seq) return null;
  }
  return {
    bizType: "ad",
    bizId: ad.id,
    entityId: ad.entityId,
    storeId: ad.storeId,
    status: ad.status,
    version: version.versionNo,
    name: ad.adNo,
    occurredAt: version.pushedAt!.toISOString(),
  };
}

export async function adsAwaitingMerchant(tx: Tx, query: Readonly<Record<string, unknown>>) {
  if (!(query.pushedFrom instanceof Date) || !(query.pushedTo instanceof Date))
    throw new TypeError("广告提醒时间范围缺失");
  const versions = await tx.adVersion.findMany({
    where: {
      pushedAt: { gte: query.pushedFrom, lte: query.pushedTo },
      decision: null,
      ad: {
        status: "pending_confirm",
        openCancelRequestId: null,
        store: { lifecycle: "active", entity: { lifecycle: "active" } },
      },
    },
    select: { adId: true, versionNo: true, ad: { select: { latestVersionNo: true } } },
    orderBy: [{ adId: "asc" }, { versionNo: "asc" }],
  });
  return versions
    .filter((version) => version.versionNo === version.ad.latestVersionNo)
    .map((version) => ({ adId: version.adId, version: version.versionNo }));
}

export async function revalidateAdReminder(tx: Tx, target: Readonly<Record<string, unknown>>) {
  const fact = typeof target.adId === "string" ? await adVersionForNotify(tx, target.adId) : null;
  return { valid: fact !== null && fact.version === target.version };
}

/** Staff notices distinguish qualification waiting from a persisted contractual breach. */
export async function adSlaForNotify(tx: Tx, adId: string, at: { now: Date }) {
  if (!(at?.now instanceof Date)) throw new TypeError("广告SLA通知缺少本实例当前时间");
  const ad = await tx.ad.findUnique({ where: { id: adId } });
  if (
    !ad ||
    !ad.dueAt ||
    ad.dueAt > at.now ||
    ad.openCancelRequestId ||
    !["pending_assign", "producing", "revising"].includes(ad.status)
  )
    return null;
  const profile = await readAdTaskStore(tx, ad);
  const waiting = ad.status === "pending_assign" && profile.store.qualificationStatus === "pending";
  let status = waiting ? "waiting_qualification" : "first_overdue",
    version = ad.resubmitCount * 2;
  if (ad.status === "revising") {
    const revision = await tx.adRevision.findUnique({
      where: { adId_revisionNo: { adId, revisionNo: ad.revisionCount } },
    });
    if (
      !revision?.breachedAt ||
      revision.breachedAt > at.now ||
      revision.fulfilledByVersionNo !== null ||
      revision.dueAt.getTime() !== ad.dueAt.getTime()
    )
      return null;
    status = "revision_overdue";
    version = revision.revisionNo * 2 + 1;
  } else if (
    (!waiting && !ad.firstBreachedAt) ||
    (await tx.adVersion.count({ where: { adId, pushedAt: { not: null } } }))
  )
    return null;
  const staffIds: string[] = [];
  for (const staff of await staffContextsForNotify(tx)) {
    if (
      !decideAccess(staff, { module: { module: "delivery", need: "view" }, permission: null })
        .allowed ||
      !(
        (staff.staff.id === ad.editorId && staff.staff.roleKey === "editor") ||
        (staff.staff.id === profile.deliveryManagerId &&
          staff.staff.roleKey === "delivery_manager") ||
        (staff.staff.roleKey === "delivery_manager" && staff.staff.isLead)
      )
    )
      continue;
    const visible = await tx.ad.findFirst({
      where: {
        id: adId,
        ...taskScope<Prisma.AdWhereInput>(staff.scope, {
          store: (store) => ({ store }),
          assignees: [{ col: "editorId", pool: "ad_editor" }],
        }),
        ...(staff.moduleLevels.delivery === "o" ? { editorId: staff.staff.id } : {}),
      },
      select: { id: true },
    });
    if (visible) staffIds.push(staff.staff.id);
  }
  return {
    bizType: "ad",
    bizId: adId,
    entityId: ad.entityId,
    storeId: ad.storeId,
    status,
    version,
    name: ad.adNo,
    occurredAt: ad.dueAt.toISOString(),
    staffIds: staffIds.sort(),
    summary: waiting
      ? "广告待指派，门店资质仍在审核中，请跟进。"
      : "广告制作已超过当前轮次时限，请处理。",
  };
}

export async function adConsentFacts(tx: Tx): Promise<TransactionConsentFact[]> {
  return (
    await tx.ad.findMany({
      select: {
        id: true,
        adNo: true,
        entityId: true,
        requestedByUserId: true,
        submittedAt: true,
        agreementConsentId: true,
      },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    bizType: "ad",
    bizId: row.id,
    bizNo: row.adNo,
    entityId: row.entityId,
    merchantUserId: row.requestedByUserId,
    at: row.submittedAt,
    agreementKeys: ["ad_service"],
    consentId: row.agreementConsentId,
  }));
}
