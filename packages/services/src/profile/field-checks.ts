import type { QualificationDoc } from "@liyoxi/db";
import { readQualificationRecognition, runQualificationFieldChecks } from "../media/index.js";
import type { Tx } from "../kernel/index.js";
import type { ProfileDeps } from "./context.js";
import { validUscc } from "./documents.js";
import { permitSpec, roundInclude, storeOf, submittedFields } from "./repo.js";

export async function qualificationChecks(
  tx: Tx,
  deps: Pick<ProfileDeps, "keyring" | "clock">,
  roundId: string,
  persist = false,
) {
  const round = await tx.qualificationSubmission.findUniqueOrThrow({
    where: { id: roundId },
    include: roundInclude,
  });
  const store = await storeOf(tx, round.storeId),
    keyring = deps.keyring(),
    now = deps.clock.now();
  const values = (doc: QualificationDoc) => submittedFields(keyring, doc);
  const license = round.qualificationDocs.find((d) => d.docType === "business_license");
  const branch = round.qualificationDocs.find((d) => d.docType === "branch_license");
  const entityName =
    round.kind === "initial" && license ? (values(license).name ?? null) : store.entity.name;
  const failures = [],
    counts = { fail: 0, warn: 0, manual: 0 };
  const documents = [];
  for (const doc of round.qualificationDocs) {
    const fields = values(doc),
      spec = doc.docType === "industry_permit" ? await permitSpec(tx, doc.permitType!) : null;
    const checks = runQualificationFieldChecks({
      recognition: await readQualificationRecognition(tx, keyring, doc),
      fields,
      docType: doc.docType,
      now,
      usccValid: validUscc(fields.uscc ?? ""),
      entityName: round.kind === "change" ? store.entity.name : null,
      licenseName:
        doc.docType === "industry_permit" && branch ? (values(branch).name ?? null) : entityName,
      claimedType: round.claimedEntityType ?? store.entity.entityType,
      ...(spec
        ? { permit: { holderNameKey: spec.holderNameKey, validToKey: spec.validToKey } }
        : {}),
    });
    documents.push({ id: doc.id, checks });
    for (const check of checks) {
      if (check.result === "fail")
        failures.push({ qualificationDocId: doc.id, code: check.code, field: check.field });
      if (check.result === "fail" || check.result === "warn" || check.result === "manual")
        counts[check.result]++;
    }
    if (persist)
      await tx.qualificationDoc.update({
        where: { id: doc.id },
        data: { fieldChecks: checks.map((c) => ({ ...c })), updatedAt: now },
      });
  }
  const reason = failures.some((f) => f.code === "C3" || f.code === "C9")
    ? "R03"
    : failures.length
      ? "R02"
      : null;
  const summary = {
    ...counts,
    suggestedReasonCode: reason,
    suggestedNote:
      reason === "R03" ? "证照已过期，请补传" : reason ? "主体与档案不一致，请核实" : null,
  };
  if (persist)
    await tx.qualificationSubmission.update({
      where: { id: round.id },
      data: { checkSummary: summary, checksRanAt: now, updatedAt: now },
    });
  return { failures, summary, documents };
}
