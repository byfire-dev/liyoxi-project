import { QUALIFICATION_DECLARATION_VERSION } from "@liyoxi/contract";
import type { QualificationSubmitBody } from "@liyoxi/contract";
import { AppError, lockRows, trackOf } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { findVerifiedEntityByUsccBidx } from "../tenant/index.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { assertDocumentsComplete } from "./documents.js";
import {
  ensureProfile,
  refreshCompleteness,
  requiredPermits,
  roundInclude,
  snapshot,
} from "./repo.js";
import { assertOwner, validateBasics } from "./validate.js";
import { changedBasics, roundBasics } from "./round-basics.js";

export async function submitQualification(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: QualificationSubmitBody,
) {
  const { storeId, entityId } = viewer.membership;
  const found = await tx.qualificationSubmission.findFirst({
    where: { id: input.qualificationSubmissionId, storeId, entityId },
  });
  if (!found || found.closedAt || found.submittedAt) throw new AppError("STATE_NOT_ALLOWED");
  await lockRows(tx, "qualification_submission", [found.id]);
  await lockRows(tx, "entity", [entityId]);
  await lockRows(tx, "store", [storeId]);
  const membership = await deps.tenant.resolveMembership(tx, {
    merchantUserId: viewer.principal.merchantUserId,
    storeId,
  });
  if (
    !membership ||
    membership.memberId !== viewer.membership.memberId ||
    membership.entityId !== entityId
  )
    throw new AppError("NOT_A_MEMBER");
  assertOwner({ ...viewer, membership });
  const now = deps.clock.now();
  await ensureProfile(tx, storeId, now);
  const s = await snapshot(tx, storeId),
    p = s.profile!;
  const round = await tx.qualificationSubmission.findUniqueOrThrow({
    where: { id: found.id },
    include: roundInclude,
  });
  if (round.closedAt || round.submittedAt || s.open?.id !== round.id)
    throw new AppError("STATE_NOT_ALLOWED");
  const basics = roundBasics(s, round.kind === "change" ? round : null);
  const permits = await requiredPermits(tx, basics.categoryCode);
  const missing = s.completeness.steps
    .filter((step) => round.kind !== "change" || step.step < 4)
    .flatMap((step) =>
      // 草稿勾选只用于回显；提交确认独立按第 6 项的本次请求校验并在提交 UPDATE 写入。
      step.missing
        .filter((item) => !(step.step === 4 && item.item === "declaration"))
        .map((item) => ({ step: step.step, ...item })),
    );
  if (
    round.kind === "change" &&
    round.qualificationDocs.some((d) => d.docType === "business_license") &&
    !round.claimedEntityType
  )
    missing.push({ step: 4, item: "entity_type", permitType: null });
  if (missing.length) throw new AppError("STORE_PROFILE_INCOMPLETE", { details: { missing } });
  await validateBasics(
    tx,
    {
      industryCode: basics.industryCode,
      categoryCode: basics.categoryCode,
      address: {
        provinceCode: basics.address.provinceCode,
        cityCode: basics.address.cityCode,
        districtCode: basics.address.districtCode,
        zoneCode: p.zoneCode,
      },
    },
    p,
    true,
  );
  const docs = round.qualificationDocs;
  if (
    (round.kind === "initial" &&
      docs.filter((d) => d.docType === "business_license").length !== 1) ||
    (round.kind === "new_store" && docs.some((d) => d.docType === "business_license")) ||
    permits.some(
      (code) => !docs.some((d) => d.docType === "industry_permit" && d.permitType === code),
    )
  )
    throw new AppError("QUALIFICATION_DOCS_INCOMPLETE");
  await assertDocumentsComplete(tx, deps, docs);
  if (round.resubmitOfQualificationSubmissionId) {
    const rejected = await tx.qualificationDoc.findMany({
      where: {
        qualificationSubmissionId: round.resubmitOfQualificationSubmissionId,
        removedAt: null,
        verdict: "rejected",
      },
    });
    const absent = rejected
      .filter(
        (old) =>
          !docs.some(
            (doc) =>
              doc.origin === "uploaded" &&
              doc.docType === old.docType &&
              doc.permitType === old.permitType,
          ),
      )
      .map((doc) => ({ docType: doc.docType, permitType: doc.permitType }));
    if (absent.length)
      throw new AppError("QUALIFICATION_DOCS_INCOMPLETE", {
        details: { rejectedNotReplaced: absent },
      });
  }
  // M1 无 OCR 结果，主体类型比对按 unavailable 放行；每轮仍需再次确认现行声明。
  if (!input.declarationConfirmed || input.declarationVersion !== QUALIFICATION_DECLARATION_VERSION)
    throw new AppError("DECLARATION_REQUIRED", {
      details: { currentVersion: QUALIFICATION_DECLARATION_VERSION },
    });
  const license = docs.find((d) => d.docType === "business_license");
  if (license && !license.certNoBidx) throw new AppError("QUALIFICATION_DOCS_INCOMPLETE");
  if (license?.certNoBidx && (await findVerifiedEntityByUsccBidx(tx, license.certNoBidx, entityId)))
    throw new AppError("USCC_TAKEN");
  if (!s.store.isPrimary && s.store.entity.verificationStatus !== "verified")
    throw new AppError("ENTITY_NOT_VERIFIED");
  if (
    (round.kind === "initial" &&
      (!s.store.isPrimary || s.store.entity.verificationStatus === "verified")) ||
    (round.kind !== "initial" && s.store.entity.verificationStatus !== "verified") ||
    (round.kind === "change") !== (s.store.qualificationStatus === "verified")
  )
    throw new AppError("STATE_NOT_ALLOWED");
  if (s.store.qualificationStatus === "pending") throw new AppError("QUALIFICATION_IN_REVIEW");
  if (p.finalRejectedAt) throw new AppError("QUALIFICATION_CLOSED");
  if (s.store.lifecycle !== "active" || s.store.entity.lifecycle !== "active")
    throw new AppError("STATE_NOT_ALLOWED");
  if (
    round.kind === "change" &&
    license &&
    (await tx.qualificationSubmission.findFirst({
      where: {
        entityId,
        id: { not: round.id },
        kind: "change",
        submittedAt: { not: null },
        closedAt: null,
        changedFields: { has: "entity_license" },
      },
    }))
  )
    throw new AppError("ENTITY_LICENSE_CHANGE_PENDING");
  const changedFields = round.kind === "change" ? changedBasics(s, round) : [];
  if (round.kind === "change") {
    const effective = await tx.qualificationDoc.findMany({
      where: {
        storeId,
        scope: "store",
        effectiveAt: { not: null },
        supersededAt: null,
        removedAt: null,
      },
      select: { id: true },
    });
    const storeDocs = docs.filter((d) => d.scope === "store");
    if (
      storeDocs.length !== effective.length ||
      storeDocs.some(
        (d) =>
          d.origin === "uploaded" ||
          !effective.some((e) => e.id === d.carriedFromQualificationDocId),
      )
    )
      changedFields.push("docs");
    if (license) changedFields.push("entity_license");
    if (!changedFields.length) throw new AppError("QUALIFICATION_NO_CHANGE");
  }
  const max = await tx.qualificationSubmission.aggregate({
    where: { storeId },
    _max: { roundNo: true },
  });
  const roundNo = (max._max.roundNo ?? 0) + 1;
  const proposed = {
    proposedStoreName: basics.storeName!,
    proposedIndustryCode: basics.industryCode!,
    proposedCategoryCode: basics.categoryCode!,
    proposedAddressSnapshot: basics.address,
    changedFields,
  };
  // 审批摘要取本次送审值；最终提交仍同一次UPDATE写齐审批关联、确认与时间戳。
  await tx.qualificationSubmission.update({ where: { id: round.id }, data: proposed });
  const approval = await deps.approval.submit(tx, viewer.ctx, {
    kind: "qualification",
    subjectType: "store",
    subjectId: storeId,
    entityId,
    storeId,
    input: { submissionId: round.id, roundNo },
  });
  await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: {
      roundNo,
      ...proposed,
      ...(p.contactName && p.contactPhoneMask && p.contactPhoneSource
        ? {
            contactSnapshot: {
              name: p.contactName!,
              phoneMask: p.contactPhoneMask!,
              phoneSource: p.contactPhoneSource!,
            },
          }
        : {}),
      declarationConfirmedAt: now,
      declarationVersion: input.declarationVersion,
      checkSummary: {
        fail: 0,
        warn: 0,
        manual: docs.length,
        suggestedReasonCode: null,
        suggestedNote: null,
      },
      checksRanAt: null,
      approvalRequestId: approval.approvalId,
      submittedAt: now,
      submittedByUserId: viewer.principal.merchantUserId,
      lockVersion: { increment: 1 },
      updatedAt: now,
    },
  });
  await deps.tenant.setStoreQualification(tx, viewer.ctx, {
    storeId,
    round: round.kind as "initial" | "new_store" | "change",
    submissionId: round.id,
    action: "submit",
  });
  await tx.storeProfile.update({
    where: { storeId },
    data: { firstSubmittedAt: p.firstSubmittedAt ?? now, updatedAt: now },
  });
  await refreshCompleteness(tx, storeId, now);
  if (round.kind === "new_store" && roundNo === 1)
    await trackOf(deps.assembly).record(tx, {
      name: "store_add_submit",
      eventId: `store_add_submit:${round.id}`,
      subject: { userId: viewer.principal.merchantUserId, entityId, storeId },
      props: { copiedFromStoreId: p.copiedFromStoreId, copyOptions: p.copyOptions },
    });
  await deps.events.emit(
    tx,
    viewer.ctx,
    round.kind === "change"
      ? {
          type: "store.qualification_change.submitted",
          aggregate: { type: "store", id: storeId },
          payload: { v: 1, storeId, entityId, submissionId: round.id, changedFields },
        }
      : {
          type: "store.qualification.submitted",
          aggregate: { type: "store", id: storeId },
          payload: {
            v: 1,
            storeId,
            entityId,
            submissionId: round.id,
            kind: round.kind as "initial" | "new_store",
            roundNo,
          },
        },
  );
}
