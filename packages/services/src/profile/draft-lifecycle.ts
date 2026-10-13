import type { QualificationDiscardBody } from "@liyoxi/contract";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { metaOf, type ProfileDeps, type ProfileViewer } from "./context.js";
import { lockDraftStore } from "./draft.js";
import { ensureProfile, refreshCompleteness, roundInclude } from "./repo.js";
import { lockFiles } from "./validate.js";

async function releaseDoc(
  tx: Tx,
  deps: ProfileDeps,
  doc: { id: string; fileId: string; entityId: string; storeId: string },
  now: Date,
) {
  const ref = await tx.fileRef.findUnique({
    where: {
      fileId_refType_refId_role: {
        fileId: doc.fileId,
        refType: "qualification_doc",
        refId: doc.id,
        role: "main",
      },
    },
  });
  if (!ref || ref.state !== "live") throw new AppError("FILE_NOT_AVAILABLE");
  await tx.qualificationDoc.update({
    where: { id: doc.id },
    data: { removedAt: now, updatedAt: now },
  });
  await deps.media.release(tx, {
    fileId: doc.fileId,
    refType: "qualification_doc",
    refId: doc.id,
    role: "main",
    entityId: doc.entityId,
    storeId: doc.storeId,
    keepUntil: new Date(now.getTime() + 7 * 86_400_000),
  });
}

export async function removeDocument(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer, id: string) {
  const { entityId, storeId } = viewer.membership;
  const found = await tx.qualificationDoc.findFirst({ where: { id, entityId, storeId } });
  if (!found) throw new AppError("NOT_FOUND");
  await lockRows(tx, "qualification_submission", [found.qualificationSubmissionId]);
  await lockDraftStore(tx, deps, viewer);
  const round = await tx.qualificationSubmission.findFirst({
    where: { id: found.qualificationSubmissionId, entityId, storeId },
  });
  const doc = await tx.qualificationDoc.findFirst({ where: { id, entityId, storeId } });
  if (!round || !doc || doc.qualificationSubmissionId !== round.id) throw new AppError("NOT_FOUND");
  if (doc.removedAt || round.closedAt) throw new AppError("STATE_NOT_ALLOWED");
  if (round.submittedAt) throw new AppError("QUALIFICATION_IN_REVIEW");
  if (doc.effectiveAt || doc.verdict) throw new AppError("STATE_NOT_ALLOWED");
  const now = deps.clock.now();
  await ensureProfile(tx, storeId, now);
  await lockFiles(tx, [doc.fileId]);
  await releaseDoc(tx, deps, doc, now);
  const saved = await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: { lockVersion: { increment: 1 }, updatedAt: now },
  });
  await refreshCompleteness(tx, storeId, now);
  await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
    stream: "activity",
    category: "profile_edit",
    action: "profile.document.remove",
    summary: "移除资质草稿证照",
    target: { type: "qualification_doc", id },
    entityId,
    storeId,
    fields: ["removedAt"],
    before: { removedAt: null },
    after: { removedAt: now },
  });
  return {
    qualificationDocId: id,
    removedAt: now.toISOString(),
    qualificationSubmissionId: round.id,
    lockVersion: saved.lockVersion,
  };
}

export async function discardDraft(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: QualificationDiscardBody,
) {
  const { entityId, storeId } = viewer.membership;
  const found = await tx.qualificationSubmission.findFirst({
    where: { id: input.qualificationSubmissionId, entityId, storeId },
  });
  if (!found) throw new AppError("STATE_NOT_ALLOWED");
  await lockRows(tx, "qualification_submission", [found.id]);
  await lockDraftStore(tx, deps, viewer);
  const round = await tx.qualificationSubmission.findFirst({
    where: { id: found.id, entityId, storeId },
    include: roundInclude,
  });
  if (!round || round.closedAt) throw new AppError("STATE_NOT_ALLOWED");
  if (round.submittedAt) throw new AppError("QUALIFICATION_IN_REVIEW");
  if (round.kind !== "change" && round.kind !== "new_store")
    throw new AppError("STATE_NOT_ALLOWED");
  if (round.qualificationDocs.some((doc) => doc.effectiveAt || doc.verdict))
    throw new AppError("STATE_NOT_ALLOWED");
  const now = deps.clock.now();
  await ensureProfile(tx, storeId, now);
  await lockFiles(
    tx,
    round.qualificationDocs.map((doc) => doc.fileId),
  );
  for (const doc of round.qualificationDocs) await releaseDoc(tx, deps, doc, now);
  await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: { closedAt: now, outcome: "discarded", lockVersion: { increment: 1 }, updatedAt: now },
  });
  await refreshCompleteness(tx, storeId, now);
  await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
    stream: "activity",
    category: "profile_edit",
    action: "profile.qualification.discard",
    summary: "丢弃资质草稿",
    target: { type: "qualification_submission", id: round.id },
    entityId,
    storeId,
    fields: ["closedAt", "outcome"],
    before: { closedAt: null, outcome: null },
    after: { closedAt: now, outcome: "discarded" },
  });
}
