import { AdminStoreQualificationViewSchema } from "@liyoxi/contract";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import { scopedStore } from "./admin-read.js";
import { currentReviewStaff } from "./admin-authorization.js";
import type { ProfileDeps } from "./context.js";
import { dictRef, roundInclude } from "./repo.js";
import { docView, instant } from "./views.js";

/** 商家资质页签只读本店轮次和生效证照，主体营业执照是唯一跨店共享证照。 */
export async function adminStoreQualification(
  tx: Tx,
  deps: ProfileDeps,
  previous: StaffContext,
  storeId: string,
) {
  const staff = await currentReviewStaff(tx, previous, deps.clock.now());
  const store = await scopedStore(tx, staff, storeId);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: store.entityId } });
  const profile = await tx.storeProfile.findUnique({ where: { storeId } });
  const rows = await tx.qualificationSubmission.findMany({
    where: {
      storeId,
      entityId: entity.id,
      submittedAt: { not: null },
      OR: [{ outcome: null }, { outcome: { not: "discarded" } }],
    },
    include: { ...roundInclude, submittedByUser: true },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
  });
  const documents = await tx.qualificationDoc.findMany({
    where: {
      entityId: entity.id,
      removedAt: null,
      effectiveAt: { not: null },
      supersededAt: null,
      qualificationSubmission: { outcome: "approved" },
      OR: [
        { storeId, scope: "store" },
        { scope: "entity", docType: "business_license" },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const effectiveDocs = [];
  for (const doc of documents)
    effectiveDocs.push({
      ...(await docView(tx, deps.keyring(), deps.clock.now(), doc)),
      fieldChecks: doc.fieldChecks ?? [],
      isCorrected: doc.reviewedFieldsEnc !== null,
    });
  const rounds = [];
  for (const row of rows) {
    if (!row.submittedByUser || !row.approvalRequestId)
      throw new TypeError("已提交资质轮次缺提交人或审批单");
    const user = row.submittedByUser;
    const uploadedDocs = [],
      rejectedDocs = [];
    for (const doc of row.qualificationDocs) {
      const summary = {
        docType: doc.docType,
        permitType: await dictRef(tx, "permit_type", doc.permitType),
      };
      if (doc.origin === "uploaded") uploadedDocs.push(summary);
      if (doc.verdict === "rejected") rejectedDocs.push({ ...summary, qualificationDocId: doc.id });
    }
    rounds.push({
      qualificationSubmissionId: row.id,
      kind: row.kind,
      roundNo: row.roundNo,
      isResubmit: row.resubmitOfQualificationSubmissionId !== null,
      submittedAt: instant(row.submittedAt),
      submittedBy: {
        merchantUserId: user.id,
        displayName: user.displayName,
        phoneMask: user.phoneMask,
        status: user.status,
      },
      uploadedDocs,
      changedFields: row.changedFields,
      approval: await deps.approval.decisionView(tx, staff, row.approvalRequestId),
      outcome: row.outcome,
      approveMode: row.approveMode,
      rejectedDocs,
      systemRejectCode: row.systemRejectCode,
      finalRejectedAt: instant(row.finalRejectedAt),
    });
  }
  const open = rows.find((row) => row.closedAt === null);
  return AdminStoreQualificationViewSchema.parse({
    storeId,
    qualificationStatus: store.qualificationStatus,
    isChangeInReview: open?.kind === "change",
    isFinalRejected: profile?.finalRejectedAt != null,
    firstSubmittedAt: instant(profile?.firstSubmittedAt ?? null),
    firstVerifiedAt: instant(profile?.firstVerifiedAt ?? null),
    lastDecidedAt: instant(profile?.lastDecidedAt ?? null),
    entity: {
      entityId: entity.id,
      name: entity.name,
      entityType: entity.entityType,
      verificationStatus: entity.verificationStatus,
      usccMask: entity.usccMask,
      legalRepNameMask: entity.legalRepNameMask,
      verifiedAt: instant(entity.verifiedAt),
    },
    effectiveDocs,
    openRound: open
      ? {
          qualificationSubmissionId: open.id,
          kind: open.kind,
          roundNo: open.roundNo,
          submittedAt: instant(open.submittedAt),
          dueAt: instant(open.approvalRequest?.dueAt ?? null),
        }
      : null,
    rounds,
  });
}
