import { calendarDate } from "@liyoxi/shared/time";
import { paramsAt } from "../../config/index.js";
import { AppError, lockRows, SessionMutexError, uuidv7 } from "../../kernel/index.js";
import type { Clock, SessionMutex, Tx, TxRunner } from "../../kernel/index.js";
import { encryptField } from "../../security/index.js";
import type { Keyring } from "../../security/index.js";
import type {
  BusinessLicenseFields,
  OcrProvider,
  ProviderResult,
  StorageBucket,
  StorageProvider,
} from "../../providers/types.js";

export interface QualificationOcrOptions {
  readonly provider: OcrProvider;
  readonly keyring: () => Keyring;
  readonly sessionMutex: SessionMutex;
}
export interface QualificationOcrInput {
  readonly fileId: string;
  readonly entityId: string;
  readonly storeId: string;
  readonly merchantUserId: string;
  readonly docType: "business_license" | "branch_license" | "industry_permit";
  readonly permitType?: string;
}
const normalized = (value: BusinessLicenseFields): Record<string, string> => {
  const type = value.subjectType ?? "unknown";
  const fields: Record<string, string> = {
    name: value.name.trim(),
    uscc: value.uscc.replace(/\s/g, "").toUpperCase(),
    principal: value.principal.trim(),
    subjectType: type,
  };
  const role =
    value.principalRole ??
    (type === "enterprise"
      ? "legal_rep"
      : type === "individual"
        ? "operator"
        : type === "branch"
          ? "branch_head"
          : undefined);
  if (role) fields.principalRole = role;
  for (const key of ["address", "validFrom", "validTo", "businessScope"] as const)
    if (value[key] !== undefined) fields[key] = value[key];
  return fields;
};
export async function qualificationOcrFile(tx: Tx, input: QualificationOcrInput) {
  const row = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  const fail = (reason: string): never => {
    throw new AppError("FILE_NOT_USABLE", { details: { fileIds: [input.fileId], reason } });
  };
  if (!row || row.status !== "stored") return fail("not_stored");
  if (row.moderationState === "block") return fail("blocked");
  if (row.category !== (input.docType === "industry_permit" ? "kyc_permit" : "kyc_license"))
    return fail("category_mismatch");
  if (
    row.entityId !== input.entityId ||
    row.uploadActorType !== "merchant" ||
    row.uploadActorId !== input.merchantUserId ||
    row.scopeType !== (input.docType === "business_license" ? "entity" : "store") ||
    (input.docType !== "business_license" && row.storeId !== input.storeId)
  )
    return fail("scope_mismatch");
  return row;
}
export const qualificationFileVersion = (row: Awaited<ReturnType<typeof qualificationOcrFile>>) =>
  JSON.stringify([
    row.id,
    row.objectKey,
    row.etag,
    row.crc64,
    row.sha256,
    row.sizeBytes?.toString() ?? null,
  ]);

/** 同步技术结果拥有者；外呼无业务TX，结果短TX独立提交，不发异步完成事件。 */
export function createQualificationOcr(deps: {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly storage: StorageProvider;
  readonly ocr?: QualificationOcrOptions;
}) {
  async function cached(tx: Tx, input: QualificationOcrInput) {
    return tx.ocrResult.findFirst({
      where: {
        entityId: input.entityId,
        storeId: input.storeId,
        fileId: input.fileId,
        docType: input.docType === "branch_license" ? "business_license" : input.docType,
        permitType: input.permitType ?? null,
        status: "ok",
        fieldsEnc: { not: null },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
  }
  return {
    async recognize(input: QualificationOcrInput): Promise<string | null> {
      const previous = await deps.tx.run(async (tx) => {
        await qualificationOcrFile(tx, input);
        return cached(tx, input);
      });
      if (previous) return previous.id;
      if (input.docType === "industry_permit" || !deps.ocr?.provider.configured) return null;
      const options = deps.ocr;
      try {
        return await options.sessionMutex.run(
          `media:qualification-ocr:${input.entityId}:${input.storeId}`,
          async (scope) => {
            const plan = await deps.tx.run(async (tx) => {
              const file = await qualificationOcrFile(tx, input);
              const existing = await cached(tx, input);
              const now = deps.clock.now();
              const limit = (await paramsAt(tx, ["ocr.daily_limit_per_store"], now))[
                "ocr.daily_limit_per_store"
              ];
              const start = new Date(`${calendarDate(now)}T00:00:00+08:00`);
              const count = await tx.ocrResult.count({
                where: {
                  storeId: input.storeId,
                  createdAt: { gte: start, lt: new Date(start.getTime() + 86400000) },
                },
              });
              return { file, existing, allowed: count < limit };
            });
            if (plan.existing) return plan.existing.id;
            if (!plan.allowed) return null;
            await scope.assertHeld();
            const controller = new AbortController();
            const cancel = () => controller.abort();
            scope.signal.addEventListener("abort", cancel, { once: true });
            if (scope.signal.aborted) cancel();
            const timer = setTimeout(cancel, 6000);
            const started = deps.clock.now();
            let result: ProviderResult<BusinessLicenseFields>;
            try {
              // 签名只用预检后的真实正式区位置，不接受调用者URL，不把地址存库或日志。
              const signed = await deps.storage.presignGet({
                bucket: plan.file.bucket as StorageBucket,
                key: plan.file.objectKey,
                expiresSec: 600,
              });
              if (!signed.ok || controller.signal.aborted) return null;
              result = await options.provider.recognizeBusinessLicense({
                imageUrl: signed.value.url,
                signal: controller.signal,
              });
              if (controller.signal.aborted) return null;
            } catch {
              return null;
            } finally {
              clearTimeout(timer);
              scope.signal.removeEventListener("abort", cancel);
            }
            if (!result.ok && result.reason !== "rejected") return null;
            await scope.assertHeld();
            const finished = deps.clock.now();
            return deps.tx.run(async (tx) => {
              await lockRows(tx, "file_object", [input.fileId], "share");
              const current = await qualificationOcrFile(tx, input);
              if (qualificationFileVersion(current) !== qualificationFileVersion(plan.file))
                throw new AppError("PRECONDITION_CHANGED");
              const already = await cached(tx, input);
              if (already) return already.id;
              const id = uuidv7();
              await tx.ocrResult.create({
                data: {
                  id,
                  entityId: input.entityId,
                  storeId: input.storeId,
                  fileId: input.fileId,
                  docType: "business_license",
                  permitType: null,
                  provider: options.provider.status,
                  status: result.ok ? "ok" : "unreadable",
                  fieldsEnc: result.ok
                    ? encryptField(
                        options.keyring(),
                        "ocr_result.fields_enc",
                        JSON.stringify(normalized(result.value)),
                      )
                    : null,
                  warnings: result.ok ? result.value.warnings.map((code) => ({ code })) : [],
                  rawEnc:
                    result.ok && result.value.raw
                      ? encryptField(options.keyring(), "ocr_result.raw_enc", result.value.raw)
                      : null,
                  rawPurgeAt:
                    result.ok && result.value.raw
                      ? new Date(finished.getTime() + 30 * 86400000)
                      : null,
                  requestActorType: "merchant",
                  requestActorId: input.merchantUserId,
                  requestClient: "weapp",
                  latencyMs: Math.max(
                    0,
                    Math.min(2147483647, finished.getTime() - started.getTime()),
                  ),
                  createdAt: finished,
                  updatedAt: finished,
                },
              });
              return id;
            });
          },
        );
      } catch (error) {
        if (error instanceof SessionMutexError) return null;
        throw error;
      }
    },
  };
}
