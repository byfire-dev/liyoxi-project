import { z, CursorQuerySchema, QualificationRecordSchema } from "@liyoxi/contract";
import { record } from "../audit/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { metaOf, type ProfileDeps, type ProfileViewer } from "./context.js";
import { dictRef } from "./repo.js";
import { assertOwner } from "./validate.js";
import { instant } from "./views.js";

async function scope(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer) {
  assertOwner(viewer);
  const current = await deps.tenant.resolveMembership(tx, {
    merchantUserId: viewer.principal.merchantUserId,
    storeId: viewer.membership.storeId,
  });
  if (
    !current ||
    current.memberId !== viewer.membership.memberId ||
    current.entityId !== viewer.membership.entityId
  )
    throw new AppError("NOT_A_MEMBER");
  assertOwner({ ...viewer, membership: current });
}
export async function qualificationRecords(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  query: z.input<typeof CursorQuerySchema>,
) {
  await scope(tx, deps, viewer);
  const parsed = CursorQuerySchema.safeParse(query);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  const { limit, cursor } = parsed.data;
  let after = {};
  if (cursor) {
    try {
      const [entity, store, time, id] = z
        .tuple([z.uuid(), z.uuid(), z.iso.datetime(), z.uuid()])
        .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (entity !== viewer.membership.entityId || store !== viewer.membership.storeId)
        throw new Error("游标范围不符");
      after = {
        OR: [
          { submittedAt: { lt: new Date(time) } },
          { submittedAt: new Date(time), id: { lt: id } },
        ],
      };
    } catch {
      throw new AppError("VALIDATION_FAILED");
    }
  }
  const rows = await tx.qualificationSubmission.findMany({
    where: {
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      submittedAt: { not: null },
      AND: [{ OR: [{ outcome: null }, { outcome: { not: "discarded" } }] }, after],
    },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { approvalRequest: true, qualificationDocs: true },
  });
  const page = rows.slice(0, limit),
    items = [];
  for (const row of page) {
    const uploadedDocs = [],
      rejectedDocs = [],
      rejectReasons = [];
    for (const doc of row.qualificationDocs) {
      const common = {
        docType: doc.docType,
        permitType: await dictRef(tx, "permit_type", doc.permitType),
      };
      if (doc.origin === "uploaded" && doc.removedAt === null) uploadedDocs.push(common);
      if (doc.verdict === "rejected") rejectedDocs.push({ ...common, qualificationDocId: doc.id });
    }
    for (const code of row.approvalRequest?.reasonCodes ?? [])
      rejectReasons.push(await dictRef(tx, "reject_reason", code));
    items.push(
      QualificationRecordSchema.parse({
        qualificationSubmissionId: row.id,
        kind: row.kind,
        roundNo: row.roundNo,
        isResubmit: row.resubmitOfQualificationSubmissionId !== null,
        submittedAt: instant(row.submittedAt),
        uploadedDocs,
        changedFields: row.changedFields,
        outcome: row.outcome,
        decidedAt: instant(row.approvalRequest?.decidedAt),
        isDecidedBySystem: row.approvalRequest?.isDecidedBySystem ?? false,
        rejectReasons,
        decisionNote: row.approvalRequest?.decisionNote ?? null,
        rejectedDocs,
        systemRejectCode: row.systemRejectCode,
        finalRejectedAt: instant(row.finalRejectedAt),
      }),
    );
  }
  const last = page.at(-1);
  return {
    items,
    hasMore: rows.length > limit,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify([
              viewer.membership.entityId,
              viewer.membership.storeId,
              last.submittedAt!.toISOString(),
              last.id,
            ]),
          ).toString("base64url")
        : null,
  };
}

async function documentForRead(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer, id: string) {
  await scope(tx, deps, viewer);
  const doc = await tx.qualificationDoc.findFirst({
    where: { id, entityId: viewer.membership.entityId, removedAt: null },
    include: { qualificationSubmission: true, file: true },
  });
  if (!doc) throw new AppError("NOT_FOUND");
  const round = doc.qualificationSubmission,
    file = doc.file;
  const effective =
    doc.effectiveAt !== null && doc.supersededAt === null && round.outcome === "approved";
  const open = round.closedAt === null && round.outcome === null;
  const sameStore = doc.storeId === viewer.membership.storeId;
  const sharedLicense = doc.scope === "entity" && doc.docType === "business_license" && effective;
  const entityFile = doc.docType === "business_license";
  const ref = await tx.fileRef.findFirst({
    where: {
      fileId: doc.fileId,
      refType: "qualification_doc",
      refId: doc.id,
      role: "main",
      state: "live",
    },
  });
  if (
    !(sharedLicense || (sameStore && (open || effective))) ||
    round.outcome === "discarded" ||
    !ref ||
    file.entityId !== doc.entityId ||
    doc.scope !== (entityFile ? "entity" : "store") ||
    file.scopeType !== (entityFile ? "entity" : "store") ||
    file.storeId !== (entityFile ? null : doc.storeId) ||
    file.category !== (doc.docType === "industry_permit" ? "kyc_permit" : "kyc_license") ||
    file.bucket !== "secure" ||
    !["jpg", "jpeg", "png"].includes(file.ext) ||
    file.status !== "stored" ||
    file.moderationState === "block" ||
    file.deletedAt !== null ||
    file.erasedAt !== null
  )
    throw new AppError("NOT_FOUND");
  return doc;
}
/** POST签发：业务授权与引用复核先完成，签名不在事务内；成功后逐次记录访问。 */
export async function qualificationDocumentUrl(
  deps: ProfileDeps,
  viewer: ProfileViewer,
  id: string,
) {
  assertOwner(viewer);
  await deps.currentOpenid(viewer.principal);
  const doc = await deps.tx.run((tx) => documentForRead(tx, deps, viewer, id));
  const signed = await deps.media.signRead({
    fileId: doc.fileId,
    audience: "merchant",
  });
  const urlTtlSec = Math.max(
    0,
    Math.ceil((Date.parse(signed.expiresAt) - deps.clock.now().getTime()) / 1000),
  );
  await deps.currentOpenid(viewer.principal);
  await deps.tx.run(async (tx) => {
    const fresh = await documentForRead(tx, deps, viewer, id);
    if (
      fresh.fileId !== doc.fileId ||
      fresh.file.objectKey !== doc.file.objectKey ||
      fresh.file.etag !== doc.file.etag
    )
      throw new AppError("NOT_FOUND");
    await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
      stream: "access",
      category: "file_access",
      action: "profile.document.url.sign",
      summary: "查看资质证照",
      target: { type: "qualification_doc", id },
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      meta: { fileId: doc.fileId, urlTtlSec },
    });
  });
  return signed;
}
