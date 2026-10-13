import type { QualificationDocReviewBody } from "@liyoxi/contract";
import { assertPermission, storeScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { ProfileDeps } from "./context.js";
import { metaOf } from "./context.js";
import { derived, assertDocumentsComplete } from "./documents.js";
import { qualificationChecks } from "./field-checks.js";
import { adminQualificationGet, scopedRound } from "./admin-read.js";
import { ensureProfile, storeOf, submittedFields } from "./repo.js";
import { assertVersion } from "./validate.js";
import { currentReviewStaff } from "./admin-authorization.js";

export async function reviewDocument(
  tx: Tx,
  deps: ProfileDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: QualificationDocReviewBody,
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  const first = await tx.qualificationDoc.findFirst({
    where: { id, removedAt: null, store: storeScope(staff.scope) },
  });
  if (!first) throw new AppError("NOT_FOUND");
  const initial = await tx.qualificationSubmission.findUniqueOrThrow({
    where: { id: first.qualificationSubmissionId },
  });
  if (!initial.approvalRequestId) throw new AppError("APPROVAL_NOT_PENDING");
  await lockRows(tx, "staff", [staff.staff.id], "share");
  await lockRows(tx, "approval_request", [initial.approvalRequestId]);
  await lockRows(tx, "qualification_submission", [initial.id]);
  staff = await currentReviewStaff(tx, staff, deps.clock.now());
  const round = await scopedRound(tx, staff, initial.id);
  if (round.closedAt || round.approvalRequest!.status !== "pending")
    throw new AppError("APPROVAL_NOT_PENDING");
  if ((await tx.staff.findUniqueOrThrow({ where: { id: staff.staff.id } })).status !== "active")
    throw new AppError("PERMISSION_DENIED");
  assertPermission(staff, "merchant.qualification.review", deps.clock.now());
  assertVersion(round.lockVersion, input.lockVersion);
  await lockRows(tx, "entity", [round.entityId], "share");
  await lockRows(tx, "store", [round.storeId], "share");
  const store = await storeOf(tx, round.storeId);
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
    throw new AppError("PRECONDITION_CHANGED");
  const doc = round.qualificationDocs.find(
    (d) => d.id === id && d.entityId === round.entityId && d.storeId === round.storeId,
  );
  if (!doc) throw new AppError("NOT_FOUND");
  await ensureProfile(tx, round.storeId, deps.clock.now());
  const data = await derived(
    tx,
    deps,
    doc,
    { ...submittedFields(deps.keyring(), doc), ...input.fields },
    true,
  );
  const updated = await tx.qualificationDoc.update({
    where: { id },
    data: { ...data, updatedAt: deps.clock.now() },
  });
  await assertDocumentsComplete(
    tx,
    deps,
    round.qualificationDocs.map((d) => (d.id === updated.id ? updated : d)),
  );
  await qualificationChecks(tx, deps, round.id, true);
  await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: { lockVersion: { increment: 1 }, updatedAt: deps.clock.now() },
  });
  await tx.approvalRequest.update({
    where: { id: round.approvalRequestId! },
    data: { lockVersion: { increment: 1 }, updatedAt: deps.clock.now() },
  });
  const safe = (d: typeof doc) => ({
    holderName: d.holderName,
    certNoMask: d.certNoMask,
    principalNameMask: d.principalNameMask,
    subjectType: d.subjectType,
    validStartDate: d.validStartDate?.toISOString().slice(0, 10),
    validEndDate: d.validEndDate?.toISOString().slice(0, 10),
    isLongTerm: d.isLongTerm,
  });
  await record(tx, ctx.actor, metaOf(ctx), {
    stream: "activity",
    category: "review",
    action: "profile.document.correct",
    summary: "修正资质证照字段",
    target: { type: "qualification_doc", id },
    entityId: round.entityId,
    storeId: round.storeId,
    fields: Object.keys(input.fields),
    before: safe(doc),
    after: safe(updated),
    ...(input.note ? { reason: { code: "correction", text: input.note } } : {}),
  });
  return adminQualificationGet(tx, deps, staff, round.id);
}
