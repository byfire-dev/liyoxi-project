import {
  QualificationSubmissionDetailSchema,
  StoreHeaderSchema,
  StoreRowSchema,
  StaffBriefSchema,
} from "@liyoxi/contract";
import type { StoreListQuery, StaffBrief } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { hasPermission, storeScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { adminFactsOf } from "./admin-ports.js";
import type { ProfileDeps } from "./context.js";
import { dictRef, roundInclude, snapshot } from "./repo.js";
import { addressView, docView, instant } from "./views.js";
import { pendingView } from "./round-basics.js";
import { qualificationChecks } from "./field-checks.js";
export async function staffBrief(tx: Tx, id: string | null): Promise<StaffBrief | null> {
  if (!id) return null;
  const s = await tx.staff.findUnique({ where: { id } });
  return s
    ? StaffBriefSchema.parse({
        staffId: s.id,
        staffNo: s.staffNo,
        name: s.name,
        roleKey: s.staffRoleKey,
        isLead: s.isLead,
        status: s.status,
      })
    : null;
}
export async function scopedStore(tx: Tx, staff: StaffContext, id: string) {
  const s = await tx.store.findFirst({ where: { id, ...storeScope(staff.scope) } });
  if (!s) throw new AppError("NOT_FOUND");
  return s;
}
export async function scopedRound(tx: Tx, staff: StaffContext, id: string) {
  const r = await tx.qualificationSubmission.findFirst({
    where: { id, store: storeScope(staff.scope), submittedAt: { not: null } },
    include: roundInclude,
  });
  if (!r?.approvalRequestId || !r.approvalRequest) throw new AppError("NOT_FOUND");
  return r;
}
async function core(tx: Tx, deps: ProfileDeps, staff: StaffContext, id: string) {
  await scopedStore(tx, staff, id);
  const s = await snapshot(tx, id),
    p = s.profile,
    e = s.store.entity;
  const siblings = await tx.store.findMany({
    where: { entityId: e.id },
    select: { id: true, isPrimary: true, name: true, lifecycle: true },
  });
  const member = await tx.entityMember.findFirst({
    where: { entityId: e.id, role: "owner", status: "active" },
    include: { merchantUser: true },
  });
  const owner = member
    ? {
        merchantUserId: member.merchantUserId,
        displayName: member.displayName ?? member.merchantUser.displayName,
        phoneMask: member.merchantUser.phoneMask,
        status: member.merchantUser.status,
      }
    : null;
  const facts = await adminFactsOf(deps.assembly, tx, {
    entityId: e.id,
    storeId: id,
    managerId: s.store.deliveryManagerId,
    ownerId: owner?.merchantUserId ?? null,
    now: deps.clock.now(),
  });
  const { province, city, district, zone } = await addressView(tx, p);
  const actions =
    s.store.deliveryManagerId === null && hasPermission(staff, "merchant.manager.assign")
      ? ["assign-delivery-manager"]
      : [];
  const row = StoreRowSchema.parse({
    storeId: id,
    name: s.store.name,
    isPrimary: s.store.isPrimary,
    lifecycle: s.store.lifecycle,
    entity: {
      entityId: e.id,
      name: e.name,
      activeStoreCount: siblings.filter((v) => v.lifecycle === "active").length,
      primaryStoreName: siblings.find((v) => v.isPrimary)?.name ?? null,
    },
    region: { province, city, district, zone },
    industry: await dictRef(tx, "industry", p?.industryCode),
    category: await dictRef(tx, "industry", p?.categoryCode),
    qualificationStatus: s.store.qualificationStatus,
    sourceType: e.sourceType,
    deliveryManager: await staffBrief(tx, s.store.deliveryManagerId),
    subscription: facts.billing.subscription,
    points: facts.billing.points,
    totalPaidFen: s.store.isPrimary ? facts.billing.paid.totalPaidFen : null,
    lastOrderAt: facts.order.lastOrderAt,
    registeredAt: s.store.createdAt.toISOString(),
    actions,
  });
  return { s, facts, owner, row };
}
export async function adminStoreList(
  tx: Tx,
  deps: ProfileDeps,
  staff: StaffContext,
  q: StoreListQuery,
) {
  const region = q.regionCode
    ? {
        OR: [
          { provinceCode: q.regionCode },
          { cityCode: q.regionCode },
          { districtCode: q.regionCode },
          { zoneCode: q.regionCode },
        ],
      }
    : {};
  const profile: Prisma.StoreProfileWhereInput = {
    ...region,
    ...(q.industryCode ? { industryCode: q.industryCode } : {}),
    ...(q.categoryCode ? { categoryCode: q.categoryCode } : {}),
  };
  const where: Prisma.StoreWhereInput = {
    AND: [
      storeScope(staff.scope),
      {
        lifecycle: q.lifecycle,
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.qualificationStatus ? { qualificationStatus: { in: q.qualificationStatus } } : {}),
        ...(q.deliveryManagerId
          ? { deliveryManagerId: q.deliveryManagerId }
          : q.isManagerUnassigned
            ? { deliveryManagerId: null }
            : {}),
        ...(Object.keys(profile).length ? { storeProfileStore: { is: profile } } : {}),
        ...(q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: "insensitive" } },
                { entity: { name: { contains: q.q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
    ],
  };
  const total = await tx.store.count({ where });
  const stores = await tx.store.findMany({
    where,
    orderBy: [{ createdAt: q.sort.startsWith("-") ? "desc" : "asc" }, { id: "asc" }],
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize,
    select: { id: true },
  });
  const items = [];
  for (const store of stores) items.push((await core(tx, deps, staff, store.id)).row);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function adminStoreGet(tx: Tx, deps: ProfileDeps, staff: StaffContext, id: string) {
  const { s, facts, owner, row } = await core(tx, deps, staff, id);
  return StoreHeaderSchema.parse({
    ...row,
    archiveReason: s.store.archiveReason,
    archivedAt: instant(s.store.archivedAt),
    isChangeInReview: s.open?.kind === "change" && s.open.submittedAt !== null,
    isFinalRejected: s.profile?.finalRejectedAt != null,
    entity: {
      entityId: row.entity.entityId,
      name: row.entity.name,
      activeStoreCount: row.entity.activeStoreCount,
      verificationStatus: s.store.entity.verificationStatus,
    },
    contact: {
      name: s.profile?.contactName ?? null,
      phoneMask: s.profile?.contactPhoneMask ?? null,
    },
    owner,
    isWecomAdded: facts.staff.isWecomAdded,
    managerContact: facts.staff.managerContact,
    managerOpenWork: {
      dramaOrderCount: s.store.deliveryManagerId ? facts.order.dramaOrderCount : 0,
      deliveryTicketProducingCount: s.store.deliveryManagerId ? facts.delivery.producingCount : 0,
      deliveryTicketInServiceCount: s.store.deliveryManagerId ? facts.delivery.inServiceCount : 0,
      serviceTicketCount: s.store.deliveryManagerId ? facts.support.serviceTicketCount : 0,
    },
    pendingPointAdjustment: facts.billing.pendingPointAdjustment,
    paid: facts.billing.paid,
    liveDramaCount: facts.order.liveDramaCount,
    liveSummary: facts.order.liveSummary,
    deliveringTicketCount: facts.delivery.deliveringTicketCount,
    nearestAgreedLaunchDate: facts.order.nearestAgreedLaunchDate,
  });
}
export async function adminQualificationGet(
  tx: Tx,
  deps: ProfileDeps,
  staff: StaffContext,
  id: string,
) {
  const r = await scopedRound(tx, staff, id),
    s = await snapshot(tx, r.storeId),
    e = s.store.entity;
  const { province, city, district, zone } = await addressView(tx, s.profile);
  const approval = await deps.approval.decisionView(tx, staff, r.approvalRequestId!);
  const contact = r.contactSnapshot as {
    name: string | null;
    phoneMask: string | null;
    phoneSource: string | null;
  } | null;
  const currentChecks =
    !r.closedAt && r.approvalRequest!.status === "pending"
      ? await qualificationChecks(tx, deps, r.id)
      : null;
  const summary = (currentChecks?.summary ?? r.checkSummary) as {
    fail: number;
    warn: number;
    manual: number;
    suggestedReasonCode: string | null;
    suggestedNote: string | null;
  } | null;
  const docs = [];
  for (const doc of r.qualificationDocs) {
    const view = await docView(tx, deps.keyring(), deps.clock.now(), doc);
    docs.push({
      ...view,
      fieldChecks:
        currentChecks?.documents.find((d) => d.id === doc.id)?.checks ?? doc.fieldChecks ?? [],
      isCorrected: doc.reviewedFieldsEnc !== null,
    });
  }
  const license = r.qualificationDocs.find((d) => d.docType === "business_license");
  const referenceDocs = [];
  if (r.kind === "new_store" || (r.kind === "change" && !license)) {
    const references = await tx.qualificationDoc.findMany({
      where: {
        entityId: e.id,
        docType: "business_license",
        scope: "entity",
        effectiveAt: { not: null },
        supersededAt: null,
        removedAt: null,
      },
    });
    for (const doc of references)
      referenceDocs.push({
        ...(await docView(tx, deps.keyring(), deps.clock.now(), doc)),
        fieldChecks: doc.fieldChecks ?? [],
        isCorrected: doc.reviewedFieldsEnc !== null,
      });
  }
  const bidx = license?.certNoBidx;
  const inReviewElsewhereCount = bidx
    ? await tx.qualificationDoc.count({
        where: {
          certNoBidx: bidx,
          docType: "business_license",
          removedAt: null,
          entityId: { not: e.id },
          qualificationSubmission: { submittedAt: { not: null }, closedAt: null },
        },
      })
    : 0;
  const isVerifiedElsewhere = bidx
    ? (await tx.entity.count({
        where: { usccBidx: bidx, id: { not: e.id }, verificationStatus: "verified" },
      })) > 0
    : false;
  const verifiedStores = (
    await tx.store.findMany({
      where: { entityId: e.id, id: { not: r.storeId }, qualificationStatus: "verified" },
      orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
      select: { id: true, name: true },
    })
  ).map((v) => ({ storeId: v.id, name: v.name }));
  const facts = await adminFactsOf(deps.assembly, tx, {
    entityId: e.id,
    storeId: r.storeId,
    managerId: s.store.deliveryManagerId,
    ownerId: null,
    now: deps.clock.now(),
  });
  return QualificationSubmissionDetailSchema.parse({
    qualificationSubmissionId: r.id,
    kind: r.kind,
    roundNo: r.roundNo,
    isResubmit: r.resubmitOfQualificationSubmissionId !== null,
    claimedEntityType: r.claimedEntityType,
    approval,
    confirmChecks: r.approvalRequest!.confirmChecks,
    lockVersion: r.lockVersion,
    closedAt: instant(r.closedAt),
    outcome: r.outcome,
    approveMode: r.approveMode,
    systemRejectCode: r.systemRejectCode,
    finalRejectedAt: instant(r.finalRejectedAt),
    store: {
      storeId: r.storeId,
      name: s.store.name,
      isPrimary: s.store.isPrimary,
      qualificationStatus: s.store.qualificationStatus,
      industry: await dictRef(tx, "industry", s.profile?.industryCode),
      category: await dictRef(tx, "industry", s.profile?.categoryCode),
      region: { province, city, district, zone },
    },
    entity: {
      entityId: e.id,
      name: e.name,
      verificationStatus: e.verificationStatus,
      usccMask: e.usccMask,
      verifiedAt: instant(e.verifiedAt),
      verifiedStores,
    },
    proposed: await pendingView(tx, r),
    changedFields: r.changedFields,
    contact: contact
      ? { name: contact.name, phoneMask: contact.phoneMask, phoneVerifyState: contact.phoneSource }
      : null,
    profileDigest: {
      completenessPct: s.completeness.pct,
      doorCount: s.media.filter((v) => v.mediaGroup === "door").length,
      interiorCount: s.media.filter((v) => v.mediaGroup === "interior").length,
      serviceItemCount: s.services.length,
    },
    checkSummary: summary
      ? {
          ...summary,
          suggestedReason: await dictRef(tx, "reject_reason", summary.suggestedReasonCode),
        }
      : null,
    checksRanAt: instant(r.checksRanAt),
    docs,
    referenceDocs,
    duplicateUscc: { inReviewElsewhereCount, isVerifiedElsewhere },
    relatedOrders: [...facts.billing.relatedOrders, ...facts.order.relatedOrders],
    canOverride:
      approval.status === "pending" &&
      (summary?.fail ?? 0) > 0 &&
      hasPermission(staff, "merchant.qualification.override"),
    actions: approval.actions
      .filter(
        (v) => v === "approve-review" || v === "reject-review" || v === "approve" || v === "reject",
      )
      .map((v) => v.replace("-review", "")),
  });
}
