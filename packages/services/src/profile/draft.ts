import { record } from "../audit/index.js";
import { AppError, isUniqueViolation, lockRows, savepoint, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { QualificationDraftPatch } from "@liyoxi/contract";
import { QUALIFICATION_DECLARATION_VERSION } from "@liyoxi/contract";
import { metaOf } from "./context.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { ensureProfile, refreshCompleteness, roundInclude, storeOf } from "./repo.js";
import { assertOwner, assertVersion, lockFiles } from "./validate.js";

/** claim 只读调用这组前提；settle 内会重新判，不靠外呼前的旧状态写入。 */
export async function draftPreconditions(tx: Tx, storeId: string) {
  const store = await storeOf(tx, storeId);
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
  const open = await tx.qualificationSubmission.findFirst({
    where: { storeId, closedAt: null },
    include: roundInclude,
  });
  if (open?.submittedAt) throw new AppError("QUALIFICATION_IN_REVIEW");
  const profile = await tx.storeProfile.findUnique({
    where: { storeId },
    select: { finalRejectedAt: true },
  });
  if (profile?.finalRejectedAt) throw new AppError("QUALIFICATION_CLOSED");
  const kind =
    store.qualificationStatus === "verified"
      ? "change"
      : store.entity.verificationStatus === "verified"
        ? "new_store"
        : "initial";
  if (kind === "initial" && !store.isPrimary) throw new AppError("ENTITY_NOT_VERIFIED");
  if (open && open.kind !== kind) throw new AppError("STATE_NOT_ALLOWED");
  return { store, open, kind };
}
export async function lockDraftStore(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer) {
  const { entityId, storeId } = viewer.membership;
  // 这里只读父行；共享锁也阻止生命周期写，且不会升级INSERT已取得的外键键共享锁。
  await lockRows(tx, "entity", [entityId], "share");
  await lockRows(tx, "store", [storeId], "share");
  const store = await storeOf(tx, storeId);
  if (store.entityId !== entityId) throw new AppError("NOT_FOUND");
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
    throw new AppError("STORE_ARCHIVED");
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
}
export async function ensureDraft(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer) {
  const { storeId, entityId } = viewer.membership;
  const initial = await draftPreconditions(tx, storeId);
  if (initial.open) {
    await lockRows(tx, "qualification_submission", [initial.open.id]);
    await lockDraftStore(tx, deps, viewer);
    const fresh = await draftPreconditions(tx, storeId);
    if (!fresh.open || fresh.open.id !== initial.open.id) throw new AppError("STATE_NOT_ALLOWED");
    return { round: fresh.open, created: false, carried: [] as { id: string; fileId: string }[] };
  }
  const now = deps.clock.now();
  const source =
    initial.store.qualificationStatus === "rejected"
      ? await tx.qualificationSubmission.findFirst({
          where: { storeId, outcome: "rejected" },
          orderBy: { submittedAt: "desc" },
          include: roundInclude,
        })
      : null;
  let id = uuidv7();
  let created = true;
  try {
    await savepoint(tx, () =>
      tx.qualificationSubmission.create({
        data: {
          id,
          storeId,
          entityId,
          kind: initial.kind,
          claimedEntityType:
            initial.kind === "new_store" ? null : (source?.claimedEntityType ?? null),
          resubmitOfQualificationSubmissionId: source?.id ?? null,
          createdByUserId: viewer.principal.merchantUserId,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  } catch (error) {
    if (
      !isUniqueViolation(error, [
        "uq_qualification_submission_open",
        "uq_qualification_submission_entity_open",
      ])
    )
      throw error;
    const existing = await tx.qualificationSubmission.findFirst({
      where: { storeId, closedAt: null },
    });
    if (!existing) throw error;
    id = existing.id;
    created = false;
  }
  await lockRows(tx, "qualification_submission", [id]);
  await lockDraftStore(tx, deps, viewer);
  const fresh = await draftPreconditions(tx, storeId);
  if (!fresh.open || fresh.open.id !== id || fresh.kind !== initial.kind)
    throw new AppError("STATE_NOT_ALLOWED");
  await ensureProfile(tx, storeId, now);
  const linked: { id: string; fileId: string }[] = [];
  if (created) {
    const carried =
      initial.kind === "change"
        ? await tx.qualificationDoc.findMany({
            where: {
              entityId,
              storeId,
              scope: "store",
              effectiveAt: { not: null },
              supersededAt: null,
              removedAt: null,
            },
            orderBy: { id: "asc" },
          })
        : (source?.qualificationDocs ?? []).filter(
            (doc) =>
              doc.verdict !== "rejected" &&
              (initial.kind !== "new_store" || doc.docType !== "business_license"),
          );
    for (const old of carried) {
      const {
        id: _id,
        qualificationSubmissionId: _round,
        verdict: _verdict,
        effectiveAt: _effective,
        supersededAt: _superseded,
        removedAt: _removed,
        origin: _origin,
        carriedFromQualificationDocId: _source,
        createdAt: _created,
        updatedAt: _updated,
        ...copy
      } = old;
      const docId = uuidv7();
      await tx.qualificationDoc.create({
        data: {
          ...copy,
          id: docId,
          qualificationSubmissionId: id,
          origin: "carried",
          carriedFromQualificationDocId: old.id,
          fieldChecks: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      linked.push({ id: docId, fileId: old.fileId });
    }
  }
  return {
    round: await tx.qualificationSubmission.findUniqueOrThrow({
      where: { id },
      include: roundInclude,
    }),
    created,
    carried: linked,
  };
}
export async function saveDraft(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: QualificationDraftPatch,
) {
  const { round, created, carried } = await ensureDraft(tx, deps, viewer);
  if (!(created && input.lockVersion === null)) assertVersion(round.lockVersion, input.lockVersion);
  if (input.declarationConfirmed && input.declarationVersion !== QUALIFICATION_DECLARATION_VERSION)
    throw new AppError("DECLARATION_REQUIRED", {
      details: { currentVersion: QUALIFICATION_DECLARATION_VERSION },
    });
  const now = deps.clock.now();
  const data = {
    ...(input.claimedEntityType === undefined ||
    round.kind === "new_store" ||
    (round.kind === "change" &&
      !round.qualificationDocs.some((doc) => doc.docType === "business_license"))
      ? {}
      : { claimedEntityType: input.claimedEntityType }),
    ...(input.declarationConfirmed === undefined
      ? {}
      : {
          declarationConfirmedAt: input.declarationConfirmed ? now : null,
          declarationVersion: input.declarationConfirmed ? input.declarationVersion! : null,
        }),
    lockVersion: { increment: 1 },
    updatedAt: now,
  };
  const saved = await tx.qualificationSubmission.update({ where: { id: round.id }, data });
  await ensureProfile(tx, viewer.membership.storeId, now);
  await linkCarried(tx, deps, viewer, carried);
  await refreshCompleteness(tx, viewer.membership.storeId, now);
  await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
    stream: "activity",
    category: "profile_edit",
    action: "profile.qualification.save",
    target: { type: "qualification_submission", id: round.id },
    entityId: round.entityId,
    storeId: round.storeId,
    summary: "保存资质草稿",
    fields: ["claimedEntityType", "declarationConfirmedAt", "declarationVersion"],
    before: {
      claimedEntityType: round.claimedEntityType,
      declarationConfirmedAt: round.declarationConfirmedAt,
      declarationVersion: round.declarationVersion,
    },
    after: {
      claimedEntityType: saved.claimedEntityType,
      declarationConfirmedAt: saved.declarationConfirmedAt,
      declarationVersion: saved.declarationVersion,
    },
  });
}

export async function linkCarried(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  docs: readonly { id: string; fileId: string }[],
) {
  await lockFiles(
    tx,
    docs.map((doc) => doc.fileId),
  );
  for (const doc of docs)
    await deps.media.link(tx, {
      fileId: doc.fileId,
      refType: "qualification_doc",
      refId: doc.id,
      role: "main",
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
    });
}
