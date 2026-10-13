import { invariantNow, lockRows } from "../kernel/index.js";
import type {
  InvariantRunContext,
  InvariantScope,
  InvariantViolation,
  Tx,
} from "../kernel/index.js";
import { requiredPermits, snapshot } from "./repo.js";

export const PROFILE_INVARIANT_CODES = [
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "I7",
  "I8",
  "I9",
  "I10",
] as const;
export type ProfileInvariantCode = (typeof PROFILE_INVARIANT_CODES)[number];
export async function findViolations(
  tx: Tx,
  code: ProfileInvariantCode,
  scope: InvariantScope = {},
  ctx?: InvariantRunContext,
): Promise<InvariantViolation[]> {
  if (code === "I7") throw new TypeError("profile.I7必须通过当前运行时的真实系统驳回能力执行");
  const where = scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {};
  const stores = await tx.store.findMany({
    where,
    include: { entity: true, storeProfileStore: true },
    orderBy: { id: "asc" },
  });
  const result: InvariantViolation[] = [];
  const bad = (type: string, id: string, entityId: string, detail: Record<string, unknown>) =>
    result.push({ subject: { type, id }, entityId, detail });
  if (code === "I2") {
    const rows = await tx.qualificationSubmission.findMany({
      where: { ...where, submittedAt: { not: null } },
      include: { approvalRequest: true },
    });
    for (const row of rows) {
      const approval = row.approvalRequest;
      if (
        !approval ||
        approval.kind !== "qualification" ||
        (approval.status === "pending") !== (row.closedAt === null) ||
        (row.closedAt !== null && row.outcome !== approval.status)
      )
        bad("qualification_submission", row.id, row.entityId, {
          approvalStatus: approval?.status ?? null,
          outcome: row.outcome,
          closed: row.closedAt !== null,
        });
    }
    const orphan = await tx.approvalRequest.findMany({
      where: {
        kind: "qualification",
        qualificationSubmission: null,
        ...(scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {}),
      },
    });
    for (const row of orphan)
      bad("approval_request", row.id, row.entityId!, { domainMissing: true });
    return result;
  }
  if (code === "I9") {
    const docs = await tx.qualificationDoc.findMany({
      where: { ...where, removedAt: null, entity: { lifecycle: { not: "closed" } } },
    });
    for (const doc of docs)
      if (
        !(await tx.fileRef.findFirst({
          where: {
            fileId: doc.fileId,
            refType: "qualification_doc",
            refId: doc.id,
            role: "main",
            state: "live",
          },
        }))
      )
        bad("qualification_doc", doc.id, doc.entityId, {
          fileId: doc.fileId,
          liveRefMissing: true,
        });
    return result;
  }
  if (code === "I4" || code === "I10") {
    const entities = await tx.entity.findMany({
      where: scope.entityIds ? { id: { in: [...scope.entityIds] } } : {},
    });
    for (const entity of entities) {
      if (code === "I4" && entity.verificationStatus === "verified") {
        const license = await tx.qualificationDoc.findFirst({
          where: {
            entityId: entity.id,
            docType: "business_license",
            scope: "entity",
            effectiveAt: { not: null },
            supersededAt: null,
            removedAt: null,
          },
        });
        if (
          !license?.certNoBidx ||
          !entity.usccBidx ||
          !Buffer.from(entity.usccBidx).equals(Buffer.from(license.certNoBidx))
        )
          bad("entity", entity.id, entity.id, { effectiveLicenseMismatch: true });
      }
      if (code === "I10") {
        const active = await tx.qualificationSubmission.findFirst({
          where: {
            entityId: entity.id,
            kind: "initial",
            submittedAt: { not: null },
            closedAt: null,
          },
        });
        if ((entity.verificationStatus === "pending") !== (active !== null))
          bad("entity", entity.id, entity.id, {
            verificationStatus: entity.verificationStatus,
            activeRound: active?.id ?? null,
          });
      }
    }
    return result;
  }
  for (const store of stores) {
    const p = store.storeProfileStore;
    if (
      code === "I1" &&
      (await tx.qualificationSubmission.count({ where: { storeId: store.id, closedAt: null } })) > 1
    )
      bad("store", store.id, store.entityId, { multipleOpenRounds: true });
    if (code === "I3") {
      const active = await tx.qualificationSubmission.findFirst({
        where: {
          storeId: store.id,
          closedAt: null,
          submittedAt: { not: null },
          kind: { in: ["initial", "new_store"] },
        },
      });
      const effective = p?.effectiveQualificationSubmissionId
        ? await tx.qualificationSubmission.findUnique({
            where: { id: p.effectiveQualificationSubmissionId },
          })
        : null;
      if (
        (store.qualificationStatus === "pending") !== (active !== null) ||
        (store.qualificationStatus === "verified" && effective?.outcome !== "approved")
      )
        bad("store", store.id, store.entityId, {
          qualificationStatus: store.qualificationStatus,
          activeRound: active?.id ?? null,
          effectiveOutcome: effective?.outcome ?? null,
        });
    }
    if (code === "I5" && store.qualificationStatus === "verified") {
      const required = await requiredPermits(tx, p?.categoryCode);
      const docs = await tx.qualificationDoc.findMany({
        where: {
          storeId: store.id,
          docType: "industry_permit",
          removedAt: null,
          effectiveAt: { not: null },
          supersededAt: null,
        },
      });
      const missing = required.filter((key) => !docs.some((doc) => doc.permitType === key));
      if (missing.length) bad("store", store.id, store.entityId, { missingPermits: missing });
    }
    if (code === "I6" && p) {
      await lockRows(tx, "store_profile", [store.id]);
      const fresh = await tx.storeProfile.findUniqueOrThrow({ where: { storeId: store.id } });
      const actual = (await snapshot(tx, store.id)).completeness;
      if (
        fresh.completenessPct !== actual.pct ||
        fresh.requiredFilled !== actual.requiredFilled ||
        fresh.requiredTotal !== actual.requiredTotal
      ) {
        const now = invariantNow(ctx);
        await tx.storeProfile.update({
          where: { storeId: store.id },
          data: {
            completenessPct: actual.pct,
            requiredFilled: actual.requiredFilled,
            requiredTotal: actual.requiredTotal,
            updatedAt: now,
          },
        });
        result.push({
          subject: { type: "store_profile", id: store.id },
          entityId: store.entityId,
          detail: {
            expectedPct: actual.pct,
            actualPct: fresh.completenessPct,
            expectedFilled: actual.requiredFilled,
            actualFilled: fresh.requiredFilled,
            expectedTotal: actual.requiredTotal,
            actualTotal: fresh.requiredTotal,
          },
          healed: { action: "重算完整度三列", at: now },
        });
      }
    }
    if (code === "I8" && store.qualificationStatus === "verified") {
      const last = await tx.qualificationSubmission.findFirst({
        where: { storeId: store.id, outcome: "approved" },
        orderBy: { submittedAt: "desc" },
      });
      const a = last?.proposedAddressSnapshot as {
        provinceCode?: string;
        cityCode?: string;
        districtCode?: string;
        detail?: string;
      } | null;
      if (
        !last ||
        store.name !== last.proposedStoreName ||
        p?.industryCode !== last.proposedIndustryCode ||
        p?.categoryCode !== last.proposedCategoryCode ||
        p?.provinceCode !== a?.provinceCode ||
        p?.cityCode !== a?.cityCode ||
        p?.districtCode !== a?.districtCode ||
        p?.addressDetail !== a?.detail
      )
        bad("store", store.id, store.entityId, { snapshotMismatch: true });
    }
  }
  return result;
}
