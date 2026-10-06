import type { QualificationDocCreateBody, QualificationDocPatch } from "@liyoxi/contract";
import type { QualificationDoc } from "@liyoxi/db";
import { maskName, maskUscc } from "@liyoxi/shared/mask";
import { parseLocalDate } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import { AppError, uuidv7, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { encryptField, sealUscc } from "../security/index.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { metaOf } from "./context.js";
import { draftPreconditions, ensureDraft, linkCarried } from "./draft.js";
import { ensureProfile, permitSpec, refreshCompleteness, submittedFields } from "./repo.js";
import { assertVersion, invalid, lockFiles, newCode, newFile } from "./validate.js";
import { docView } from "./views.js";

const LICENSE_KEYS = [
  "name",
  "uscc",
  "principal",
  "principalRole",
  "subjectType",
  "validFrom",
  "validTo",
  "address",
  "businessScope",
];
const USCC_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
export function validUscc(value: string): boolean {
  if (value.length !== 18 || [...value].some((c) => !USCC_CHARS.includes(c))) return false;
  const sum = [...value.slice(0, 17)].reduce(
    (n, c, i) => n + USCC_CHARS.indexOf(c) * USCC_WEIGHTS[i]!,
    0,
  );
  return value[17] === USCC_CHARS[(31 - (sum % 31)) % 31];
}
function date(value: string | undefined) {
  if (!value || value === "long_term") return null;
  try {
    parseLocalDate(value);
  } catch {
    throw invalid("证照日期格式不符");
  }
  return new Date(`${value}T00:00:00Z`);
}
export async function docPrecheck(
  tx: Tx,
  viewer: ProfileViewer,
  input: QualificationDocCreateBody,
) {
  await draftPreconditions(tx, viewer.membership.storeId);
  if (input.docType === "industry_permit")
    await newCode(tx, "permit_type", input.permitType, null, "permitType");
  await newFile(
    tx,
    viewer,
    input.fileId,
    [input.docType === "industry_permit" ? "kyc_permit" : "kyc_license"],
    input.docType === "business_license" ? "entity" : "store",
  );
}
export async function createDoc(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: QualificationDocCreateBody,
) {
  const { round, carried } = await ensureDraft(tx, deps, viewer);
  await docPrecheck(tx, viewer, input);
  const now = deps.clock.now(),
    { storeId, entityId } = viewer.membership;
  await ensureProfile(tx, storeId, now);
  const old = await tx.qualificationDoc.findFirst({
    where: {
      qualificationSubmissionId: round.id,
      docType: input.docType,
      permitType: input.permitType ?? null,
      removedAt: null,
    },
  });
  await lockFiles(tx, [input.fileId, old?.fileId, ...carried.map((d) => d.fileId)]);
  await linkCarried(tx, deps, viewer, carried);
  if (old) {
    await tx.qualificationDoc.update({
      where: { id: old.id },
      data: { removedAt: now, updatedAt: now },
    });
    await deps.media.release(tx, {
      fileId: old.fileId,
      refType: "qualification_doc",
      refId: old.id,
      role: "main",
      entityId,
      storeId,
      keepUntil: new Date(now.getTime() + 7 * 86_400_000),
    });
  }
  const doc = await tx.qualificationDoc.create({
    data: {
      id: uuidv7(),
      entityId,
      storeId,
      qualificationSubmissionId: round.id,
      docType: input.docType,
      permitType: input.permitType ?? null,
      scope: input.docType === "business_license" ? "entity" : "store",
      fileId: input.fileId,
      origin: "uploaded",
      uploadedByUserId: viewer.principal.merchantUserId,
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.media.link(tx, {
    fileId: doc.fileId,
    refType: "qualification_doc",
    refId: doc.id,
    role: "main",
    entityId,
    storeId,
  });
  const updated = await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: { lockVersion: { increment: 1 }, updatedAt: now },
  });
  await refreshCompleteness(tx, storeId, now);
  await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
    stream: "access",
    category: "file_access",
    action: "profile.document.create",
    summary: "上传资质证照",
    target: { type: "qualification_doc", id: doc.id },
    entityId,
    storeId,
    meta: { fileId: doc.fileId },
  });
  return {
    qualificationSubmissionId: round.id,
    lockVersion: updated.lockVersion,
    doc: await docView(tx, deps.keyring(), now, doc),
    recognized: null,
    submitted: null,
    entityTypeCheck: null,
    replayed: false,
  };
}
/** 加密及派生列同一次写；解密提交值由仓储函数统一完成。 */
async function derived(
  tx: Tx,
  deps: ProfileDeps,
  doc: QualificationDoc,
  fields: Record<string, string>,
) {
  const permit = doc.docType === "industry_permit" ? await permitSpec(tx, doc.permitType!) : null;
  const allowed = permit ? permit.fields.map((f) => f.key) : LICENSE_KEYS;
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw invalid("字段不属于该证照类型");
  if (Object.values(fields).some((value) => [...value].length > 2000))
    throw invalid("证照字段过长");
  if (!permit) {
    if (fields["uscc"] && !validUscc(fields["uscc"])) throw invalid("信用代码格式或校验位不符");
    if (
      fields["principalRole"] &&
      !["legal_rep", "operator", "branch_head"].includes(fields["principalRole"])
    )
      throw invalid("负责人角色不符");
    if (
      fields["subjectType"] &&
      !["enterprise", "individual", "branch", "unknown"].includes(fields["subjectType"])
    )
      throw invalid("主体类型不符");
  } else
    for (const field of permit.fields) {
      const value = fields[field.key];
      if (value && field.format === "date") date(value);
      if (
        value &&
        field.key === permit.certNoKey &&
        permit.certNoPattern &&
        !new RegExp(permit.certNoPattern).test(value)
      )
        throw invalid("许可证编号格式不符");
    }
  const number = fields[permit?.certNoKey ?? "uscc"] || null;
  const principal = fields[permit?.principalNameKey ?? "principal"] || null;
  const validFrom = fields[permit?.validFromKey ?? "validFrom"],
    validTo = fields[permit?.validToKey ?? "validTo"];
  const start = date(validFrom),
    end = date(validTo);
  if (validFrom === "long_term") throw invalid("起始日期不能为长期");
  if (start && end && end < start) throw invalid("截止日期早于起始日期");
  const sealed =
    number && !permit ? sealUscc(deps.keyring(), "qualification_doc.cert_no_enc", number) : null;
  return {
    submittedFieldsEnc: encryptField(
      deps.keyring(),
      "qualification_doc.submitted_fields_enc",
      JSON.stringify(fields),
    ),
    holderName: fields[permit?.holderNameKey ?? "name"] || null,
    certNoEnc:
      sealed?.enc ??
      (number ? encryptField(deps.keyring(), "qualification_doc.cert_no_enc", number) : null),
    certNoBidx: sealed?.bidx ?? null,
    certNoMask: sealed?.mask ?? (number ? maskUscc(number) : null),
    principalNameEnc: principal
      ? encryptField(deps.keyring(), "qualification_doc.principal_name_enc", principal)
      : null,
    principalNameMask: principal ? maskName(principal) : null,
    principalRole: fields["principalRole"] || null,
    subjectType: fields["subjectType"] || null,
    validStartDate: start,
    validEndDate: end,
    isLongTerm: validTo === "long_term",
  };
}
export async function updateDoc(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  id: string,
  input: QualificationDocPatch,
) {
  const found = await tx.qualificationDoc.findFirst({
    where: { id, storeId: viewer.membership.storeId },
  });
  if (!found) throw new AppError("NOT_FOUND");
  await lockRows(tx, "qualification_submission", [found.qualificationSubmissionId]);
  const round = await tx.qualificationSubmission.findUniqueOrThrow({
    where: { id: found.qualificationSubmissionId },
  });
  const doc = await tx.qualificationDoc.findUniqueOrThrow({ where: { id } });
  if (doc.removedAt || round.closedAt || doc.origin === "carried")
    throw new AppError("STATE_NOT_ALLOWED");
  if (round.submittedAt) throw new AppError("QUALIFICATION_IN_REVIEW");
  assertVersion(round.lockVersion, input.lockVersion);
  const fields = { ...submittedFields(deps.keyring(), doc), ...input.fields };
  const now = deps.clock.now();
  const data = await derived(tx, deps, doc, fields);
  await ensureProfile(tx, viewer.membership.storeId, now);
  const updated = await tx.qualificationDoc.update({
    where: { id },
    data: { ...data, updatedAt: now },
  });
  const changed = await tx.qualificationSubmission.update({
    where: { id: round.id },
    data: { lockVersion: { increment: 1 }, updatedAt: now },
  });
  await refreshCompleteness(tx, viewer.membership.storeId, now);
  const safe = (d: QualificationDoc) => ({
    holderName: d.holderName,
    certNoMask: d.certNoMask,
    principalNameMask: d.principalNameMask,
    subjectType: d.subjectType,
  });
  await record(tx, viewer.ctx.actor, metaOf(viewer.ctx), {
    stream: "activity",
    category: "profile_edit",
    action: "profile.document.save",
    summary: "保存证照提交值",
    target: { type: "qualification_doc", id },
    entityId: doc.entityId,
    storeId: doc.storeId,
    fields: Object.keys(input.fields),
    before: safe(doc),
    after: safe(updated),
  });
  return {
    qualificationSubmissionId: round.id,
    lockVersion: changed.lockVersion,
    doc: await docView(tx, deps.keyring(), now, updated),
  };
}
export async function assertDocumentsComplete(
  tx: Tx,
  deps: ProfileDeps,
  docs: readonly QualificationDoc[],
) {
  for (const doc of docs) {
    const fields = submittedFields(deps.keyring(), doc);
    const keys =
      doc.docType === "industry_permit"
        ? (await permitSpec(tx, doc.permitType!)).fields.map((f) => f.key)
        : [
            "name",
            "uscc",
            "principal",
            "principalRole",
            "subjectType",
            "validFrom",
            "validTo",
            "address",
          ];
    if (!doc.submittedFieldsEnc || keys.some((key) => !fields[key]?.trim()))
      throw new AppError("QUALIFICATION_DOCS_INCOMPLETE");
  }
}
