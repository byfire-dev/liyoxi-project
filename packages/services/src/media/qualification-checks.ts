import { calendarDate } from "@liyoxi/shared/time";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { decryptField } from "../security/index.js";
import type { Keyring } from "../security/index.js";

export interface QualificationRecognitionRef {
  ocrResultId: string | null;
  fileId: string;
  entityId: string;
  storeId: string;
  docType: string;
  permitType: string | null;
}
/** 只读已有识别事实，不识别、不外呼；引用污染失败，不把未知冒充已识别。 */
export async function readQualificationRecognition(
  tx: Tx,
  keyring: Keyring,
  ref: QualificationRecognitionRef,
) {
  if (!ref.ocrResultId)
    return { status: "unavailable" as const, fields: null, warnings: [] as string[] };
  const row = await tx.ocrResult.findUnique({ where: { id: ref.ocrResultId } });
  if (
    !row ||
    row.fileId !== ref.fileId ||
    row.entityId !== ref.entityId ||
    row.storeId !== ref.storeId ||
    row.docType !== (ref.docType === "branch_license" ? "business_license" : ref.docType) ||
    row.permitType !== ref.permitType
  )
    throw new AppError("PRECONDITION_CHANGED");
  if (row.status !== "ok" || !row.fieldsEnc)
    return {
      status: row.status === "unreadable" ? ("unreadable" as const) : ("unavailable" as const),
      fields: null,
      warnings: [] as string[],
    };
  const fields: unknown = JSON.parse(decryptField(keyring, "ocr_result.fields_enc", row.fieldsEnc));
  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.values(fields).some((v) => typeof v !== "string")
  )
    throw new AppError("PRECONDITION_CHANGED");
  const warnings = Array.isArray(row.warnings)
    ? row.warnings.flatMap((v) =>
        v && typeof v === "object" && "code" in v && typeof v.code === "string" ? [v.code] : [],
      )
    : [];
  return { status: "ok" as const, fields: fields as Record<string, string>, warnings };
}
export interface QualificationFieldCheck {
  code: string;
  field: string;
  result: "pass" | "fail" | "warn" | "manual" | "info";
}
const normalizeName = (s: string) =>
  s.replaceAll("（", "(").replaceAll("）", ")").replace(/\s/g, "");
/** D5 §10.3/10.4：只有真实已成功识别的文档参与C1-C10，手填降级仅C11。 */
export function runQualificationFieldChecks(input: {
  recognition: Awaited<ReturnType<typeof readQualificationRecognition>>;
  fields: Record<string, string>;
  docType: string;
  now: Date;
  usccValid: boolean;
  entityName: string | null;
  licenseName: string | null;
  claimedType: string | null;
  permit?: { holderNameKey: string; validToKey: string | null };
}): QualificationFieldCheck[] {
  if (input.recognition.status !== "ok") return [{ code: "C11", field: "ocr", result: "manual" }];
  const out: QualificationFieldCheck[] = [],
    f = input.fields;
  const put = (code: string, field: string, result: QualificationFieldCheck["result"]) =>
    out.push({ code, field, result });
  const same = (a: string | undefined, b: string) => !!a && normalizeName(a) === normalizeName(b);
  const expiry = (code: string, field: string) => {
    const end = f[field],
      today = calendarDate(input.now);
    if (!end) put(code, field, "manual");
    else if (end === "long_term") put(code, field, "pass");
    else {
      const remaining =
        (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
        86400000;
      put(
        code,
        field,
        !Number.isFinite(remaining)
          ? "manual"
          : remaining < 0
            ? "fail"
            : remaining <= 30
              ? "warn"
              : "pass",
      );
    }
  };
  if (input.docType === "industry_permit") {
    if (input.licenseName && input.permit)
      put(
        "C8",
        input.permit.holderNameKey,
        same(f[input.permit.holderNameKey], input.licenseName) ? "pass" : "fail",
      );
    if (input.permit?.validToKey) expiry("C9", input.permit.validToKey);
  } else {
    if (input.docType === "business_license" && input.entityName)
      put("C1", "name", same(f.name, input.entityName) ? "pass" : "fail");
    put("C2", "uscc", input.usccValid ? "pass" : "fail");
    expiry("C3", "validTo");
    if (input.docType === "business_license" && input.claimedType)
      put("C4", "subjectType", f.subjectType === input.claimedType ? "pass" : "fail");
    put("C5", "address", "manual");
    if (input.docType === "branch_license" && input.licenseName)
      put(
        "C10",
        "name",
        f.name && normalizeName(f.name).startsWith(normalizeName(input.licenseName))
          ? "pass"
          : "manual",
      );
  }
  for (const key of Object.keys(f))
    if (input.recognition.fields?.[key] !== f[key]) put("C6", key, "info");
  if (input.recognition.warnings.length) put("C7", "ocr", "warn");
  return out;
}
