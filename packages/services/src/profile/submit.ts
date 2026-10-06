import { QUALIFICATION_DECLARATION_VERSION } from "@liyoxi/contract";
import type { QualificationSubmitBody } from "@liyoxi/contract";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { findVerifiedEntityByUsccBidx } from "../tenant/index.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { assertDocumentsComplete } from "./documents.js";
import { ensureProfile, refreshCompleteness, roundInclude, snapshot } from "./repo.js";
import { validateBasics } from "./validate.js";

export async function submitQualification(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: QualificationSubmitBody,
) {
  const { storeId, entityId } = viewer.membership;
  const found = await tx.qualificationSubmission.findFirst({
    where: { id: input.qualificationSubmissionId, storeId },
  });
  if (!found || found.closedAt || found.submittedAt) throw new AppError("STATE_NOT_ALLOWED");
  await lockRows(tx, "qualification_submission", [found.id]);
  await lockRows(tx, "entity", [entityId]);
  await lockRows(tx, "store", [storeId]);
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
  const missing = s.completeness.steps.flatMap((step) =>
    // 草稿勾选只用于回显；提交确认独立按第 6 项的本次请求校验并在提交 UPDATE 写入。
    step.missing
      .filter((item) => !(step.step === 4 && item.item === "declaration"))
      .map((item) => ({ step: step.step, ...item })),
  );
  if (missing.length) throw new AppError("STORE_PROFILE_INCOMPLETE", { details: { missing } });
  await validateBasics(
    tx,
    {
      industryCode: p.industryCode,
      categoryCode: p.categoryCode,
      address: {
        provinceCode: p.provinceCode,
        cityCode: p.cityCode,
        districtCode: p.districtCode,
        zoneCode: p.zoneCode,
      },
    },
    p,
    true,
  );
  const docs = round.qualificationDocs;
  if (
    docs.filter((d) => d.docType === "business_license").length !== 1 ||
    s.permits.some(
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
  const license = docs.find((d) => d.docType === "business_license")!;
  if (!license.certNoBidx) throw new AppError("QUALIFICATION_DOCS_INCOMPLETE");
  if (await findVerifiedEntityByUsccBidx(tx, license.certNoBidx, entityId))
    throw new AppError("USCC_TAKEN");
  if (!s.store.isPrimary && s.store.entity.verificationStatus !== "verified")
    throw new AppError("ENTITY_NOT_VERIFIED");
  if (round.kind !== "initial" || !s.store.isPrimary)
    throw new AppError("STATE_NOT_ALLOWED", { details: { reason: "new_store_round_not_open" } });
  if (s.store.qualificationStatus === "pending") throw new AppError("QUALIFICATION_IN_REVIEW");
  if (p.finalRejectedAt) throw new AppError("QUALIFICATION_CLOSED");
  if (s.store.lifecycle !== "active" || s.store.entity.lifecycle !== "active")
    throw new AppError("STATE_NOT_ALLOWED");
  const max = await tx.qualificationSubmission.aggregate({
    where: { storeId },
    _max: { roundNo: true },
  });
  const roundNo = (max._max.roundNo ?? 0) + 1;
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
      proposedStoreName: s.store.name!,
      proposedIndustryCode: p.industryCode!,
      proposedCategoryCode: p.categoryCode!,
      proposedAddressSnapshot: {
        provinceCode: p.provinceCode!,
        cityCode: p.cityCode!,
        districtCode: p.districtCode!,
        detail: p.addressDetail!,
        poiName: p.poiName,
        latitude: p.latitude?.toNumber() ?? null,
        longitude: p.longitude?.toNumber() ?? null,
      },
      contactSnapshot: {
        name: p.contactName!,
        phoneMask: p.contactPhoneMask!,
        phoneSource: p.contactPhoneSource!,
      },
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
    round: "initial",
    action: "submit",
  });
  await tx.storeProfile.update({
    where: { storeId },
    data: { firstSubmittedAt: p.firstSubmittedAt ?? now, updatedAt: now },
  });
  await refreshCompleteness(tx, storeId, now);
  await deps.events.emit(tx, viewer.ctx, {
    type: "store.qualification.submitted",
    aggregate: { type: "store", id: storeId },
    payload: { v: 1, storeId, entityId, submissionId: round.id, kind: "initial", roundNo },
  });
}
