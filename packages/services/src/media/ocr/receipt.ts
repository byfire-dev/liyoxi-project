import { createHash } from "node:crypto";
import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { maskBankAccount } from "@liyoxi/shared/mask";
import { AppError, actorColumns, lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { decryptField, encryptField } from "../../security/index.js";
import { BankReceiptFieldsSchema, failed } from "../../providers/types.js";
import type { BankReceiptFields, ProviderResult, StorageBucket } from "../../providers/types.js";
import type { BoundMediaDeps, FileRow } from "../context.js";
import type { JobOutcome, MediaJobHandler } from "../jobs/types.js";
import { jobBudget } from "../jobs/policy.js";

export const BankReceiptOcrInputSchema = z.strictObject({ fileId: z.uuid(), entityId: z.uuid() });
export type BankReceiptOcrInput = z.infer<typeof BankReceiptOcrInputSchema>;
const jobInput = BankReceiptOcrInputSchema.extend({
  ocrResultId: z.uuid(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
const output = z.strictObject({
  status: z.enum(["ok", "unreadable"]),
  fieldsEnc: z.string().nullable(),
  rawEnc: z.string().nullable(),
  warnings: BankReceiptFieldsSchema.shape.warnings,
  latencyMs: z.number().int().nonnegative(),
});
const warningRows = z.array(z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,80}$/) }));
const viewFields = BankReceiptFieldsSchema.omit({
  payerAccount: true,
  raw: true,
  warnings: true,
}).extend({ payerAccountMask: z.string().nullable() });
export interface BankReceiptOcrRead {
  readonly status: "pending" | "ok" | "unavailable" | "unreadable";
  readonly recognized: z.infer<typeof viewFields> | null;
  readonly warnings: readonly string[];
}
const version = (file: FileRow) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        file.id,
        file.objectKey,
        file.etag,
        file.crc64,
        file.sha256,
        file.sizeBytes?.toString(),
      ]),
    )
    .digest("hex");
const usable = (file: FileRow | null, entityId: string): file is FileRow =>
  !!file &&
  file.entityId === entityId &&
  file.category === "pay_receipt" &&
  file.scopeType === "entity" &&
  file.status === "stored" &&
  file.moderationState !== "block" &&
  ["png", "jpg", "jpeg", "pdf"].includes(file.ext);
const failure = (code: string, retryable = false): JobOutcome => ({
  state: "failed",
  failure: { code, retryable },
});

/** 原调用方事务登记，归属/文件服务端核验；不读账务表、不签URL或外呼。 */
export async function enqueueBankReceiptOcr(
  deps: BoundMediaDeps,
  tx: Tx,
  ctx: IdentityContext,
  input: BankReceiptOcrInput,
): Promise<{ ocrResultId: string | null; status: "pending" | "ok" | "unavailable" }> {
  input = BankReceiptOcrInputSchema.parse(input);
  if (ctx.entityId !== null && ctx.entityId !== input.entityId)
    throw new AppError("FILE_NOT_USABLE");
  const actor = actorColumns(ctx.actor);
  if (actor.actorType === "partner" || (actor.actorType !== "system" && actor.client === null))
    throw new TypeError("回单OCR请求身份不合法");
  await lockRows(tx, "file_object", [input.fileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  if (!usable(file, input.entityId)) throw new AppError("FILE_NOT_USABLE");
  const previous = await tx.ocrResult.findFirst({
    where: { ...input, docType: "bank_receipt", storeId: null, status: { in: ["pending", "ok"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (previous) {
    const oldJob = await tx.mediaJob.findUnique({
      where: { dedupeKey: `ocr:bank_receipt:${previous.id}` },
      select: { input: true },
    });
    const oldInput = jobInput.safeParse(oldJob?.input);
    if (oldInput.success && oldInput.data.version === version(file))
      return { ocrResultId: previous.id, status: previous.status === "ok" ? "ok" : "pending" };
  }
  if (!deps.ocr?.provider.configured) return { ocrResultId: null, status: "unavailable" };
  const now = deps.clock.now(),
    id = uuidv7();
  await tx.ocrResult.create({
    data: {
      id,
      ...input,
      storeId: null,
      docType: "bank_receipt",
      provider: deps.ocr.provider.status,
      status: "pending",
      requestActorType: actor.actorType,
      requestActorId: actor.actorId,
      requestClient: actor.client,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tx.mediaJob.create({
    data: {
      id: uuidv7(),
      kind: "ocr",
      mode: "local",
      provider: deps.ocr.provider.status,
      subjectType: "ocr_result",
      subjectId: id,
      dedupeKey: `ocr:bank_receipt:${id}`,
      state: "queued",
      input: { ...input, ocrResultId: id, version: version(file) },
      maxAttempts: 3,
      nextRunAt: now,
      deadlineAt: new Date(now.getTime() + jobBudget("ocr")!.deadlineMs),
      createdAt: now,
      updatedAt: now,
    },
  });
  return { ocrResultId: id, status: "pending" };
}
export async function readBankReceiptOcr(
  deps: BoundMediaDeps,
  tx: Tx,
  input: BankReceiptOcrInput & { ocrResultId: string; mediaJobId?: string },
): Promise<BankReceiptOcrRead | null> {
  input = BankReceiptOcrInputSchema.extend({
    ocrResultId: z.uuid(),
    mediaJobId: z.uuid().optional(),
  }).parse(input);
  const row = await tx.ocrResult.findFirst({
    where: {
      id: input.ocrResultId,
      fileId: input.fileId,
      entityId: input.entityId,
      docType: "bank_receipt",
      storeId: null,
    },
  });
  if (!row) return null;
  if (input.mediaJobId) {
    const job = await tx.mediaJob.findUnique({ where: { id: input.mediaJobId } });
    const binding = jobInput.safeParse(job?.input);
    const safe = z
      .strictObject({ ocrResultId: z.uuid(), status: z.enum(["ok", "unavailable", "unreadable"]) })
      .safeParse(job?.output);
    if (
      !job ||
      job.kind !== "ocr" ||
      job.mode !== "local" ||
      job.subjectType !== "ocr_result" ||
      job.subjectId !== row.id ||
      job.dedupeKey !== `ocr:bank_receipt:${row.id}` ||
      !["succeeded", "failed", "canceled"].includes(job.state) ||
      !binding.success ||
      binding.data.ocrResultId !== row.id ||
      binding.data.fileId !== row.fileId ||
      binding.data.entityId !== row.entityId ||
      !safe.success ||
      safe.data.ocrResultId !== row.id ||
      safe.data.status !== row.status
    )
      return null;
    const source = await tx.fileObject.findUnique({ where: { id: row.fileId } });
    if (!usable(source, row.entityId) || version(source) !== binding.data.version) return null;
  }
  const status = z.enum(["pending", "ok", "unavailable", "unreadable"]).parse(row.status);
  const warnings = warningRows.parse(row.warnings).map((item) => item.code);
  if (status !== "ok" || !row.fieldsEnc || !deps.ocr) return { status, recognized: null, warnings };
  const fields = BankReceiptFieldsSchema.parse(
    JSON.parse(decryptField(deps.ocr.keyring(), "ocr_result.fields_enc", row.fieldsEnc)),
  );
  const { payerAccount, warnings: _warnings, raw: _raw, ...recognized } = fields;
  return {
    status,
    recognized: viewFields.parse({
      ...recognized,
      payerAccountMask: payerAccount === null ? null : maskBankAccount(payerAccount),
    }),
    warnings,
  };
}

/** 复用原runner的真实槽、领取/重试/期限；结果与完成事件在其终态TX一起写。 */
export function createBankReceiptOcrHandler(deps: BoundMediaDeps): MediaJobHandler {
  async function current(tx: Tx, job: MediaJob) {
    const parsed = jobInput.safeParse(job.input);
    if (
      !parsed.success ||
      job.subjectType !== "ocr_result" ||
      job.subjectId !== parsed.data.ocrResultId ||
      job.dedupeKey !== `ocr:bank_receipt:${job.subjectId}`
    )
      return false;
    await lockRows(tx, "file_object", [parsed.data.fileId]);
    const row = await tx.ocrResult.findUnique({ where: { id: job.subjectId } });
    const file = await tx.fileObject.findUnique({ where: { id: parsed.data.fileId } });
    return (
      !!row &&
      row.status === "pending" &&
      row.docType === "bank_receipt" &&
      row.storeId === null &&
      row.entityId === parsed.data.entityId &&
      row.fileId === parsed.data.fileId &&
      usable(file, row.entityId) &&
      version(file) === parsed.data.version
    );
  }
  return {
    kind: "ocr",
    mode: "local",
    validInput: (value) => jobInput.safeParse(value).success,
    validOutput: (value) => output.safeParse(value).success,
    current,
    prepare: async (tx, job) =>
      tx.fileObject.findUniqueOrThrow({ where: { id: jobInput.parse(job.input).fileId } }),
    async execute(_job, context, parentSignal) {
      const ocr = deps.ocr;
      if (!ocr?.provider.configured) return failure("OCR_UNAVAILABLE");
      const file = context as FileRow;
      const started = deps.clock.now();
      const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(6000)]);
      let abort!: () => void;
      const canceled = new Promise<ProviderResult<BankReceiptFields>>((resolve) => {
        abort = () => resolve(failed("unavailable", "回单识别已取消"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      let result: ProviderResult<BankReceiptFields>;
      try {
        result = await Promise.race([
          canceled,
          (async () => {
            const signed = await deps.storage.presignGet({
              bucket: file.bucket as StorageBucket,
              key: file.objectKey,
              expiresSec: 600,
            });
            if (!signed.ok || signal.aborted) return failed("unavailable", "回单文件暂不可读");
            return ocr.provider.recognizeBankReceipt({ fileUrl: signed.value.url, signal });
          })(),
        ]);
      } catch {
        return failure("OCR_UNAVAILABLE", true);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted) return failure("OCR_TIMEOUT", true);
      if (!result.ok && result.reason !== "rejected")
        return failure("OCR_UNAVAILABLE", result.reason === "unavailable");
      const fields = result.ok ? BankReceiptFieldsSchema.parse(result.value) : null;
      const { raw, ...normalized } = fields ?? { raw: undefined };
      return {
        state: "succeeded",
        output: {
          status: fields ? "ok" : "unreadable",
          fieldsEnc: fields
            ? encryptField(ocr.keyring(), "ocr_result.fields_enc", JSON.stringify(normalized))
            : null,
          rawEnc: raw ? encryptField(ocr.keyring(), "ocr_result.raw_enc", raw) : null,
          warnings: fields?.warnings ?? ["UNREADABLE_RECEIPT"],
          latencyMs: Math.min(
            2147483647,
            Math.max(0, deps.clock.now().getTime() - started.getTime()),
          ),
        },
      };
    },
    async finish(tx, job, outcome, ctx) {
      // 自动重试尚未终态时保留pending；取消/耗尽也须收尾，不能遗留永久pending。
      if (!["succeeded", "failed", "canceled"].includes(job.state)) return;
      const binding = jobInput.safeParse(job.input);
      if (
        !binding.success ||
        job.subjectType !== "ocr_result" ||
        job.subjectId !== binding.data.ocrResultId ||
        job.dedupeKey !== `ocr:bank_receipt:${job.subjectId}`
      )
        return;
      const row = await tx.ocrResult.findUnique({ where: { id: job.subjectId } });
      if (
        !row ||
        row.status !== "pending" ||
        row.docType !== "bank_receipt" ||
        row.fileId !== binding.data.fileId ||
        row.entityId !== binding.data.entityId
      )
        return;
      const value = outcome.state === "succeeded" ? output.parse(outcome.output) : null;
      const status = value?.status ?? "unavailable",
        now = deps.clock.now();
      await tx.ocrResult.update({
        where: { id: row.id },
        data: {
          status,
          fieldsEnc: value?.fieldsEnc ?? null,
          rawEnc: value?.rawEnc ?? null,
          rawPurgeAt: value?.rawEnc ? new Date(now.getTime() + 30 * 86400000) : null,
          warnings: (value?.warnings ?? ["OCR_UNAVAILABLE"]).map((code) => ({ code })),
          latencyMs: value?.latencyMs ?? null,
          updatedAt: now,
        },
      });
      // runner先写结果；同一TX内把opaque密文搬到唯一OCR行，任务最终只留安全绑定。
      await tx.mediaJob.update({
        where: { id: job.id },
        data: { output: { ocrResultId: row.id, status } },
      });
      await deps.events.emit(tx, ctx, {
        type: "media.ocr.completed",
        aggregate: { type: "ocr_result", id: row.id },
        entityId: row.entityId,
        storeId: null,
        payload: {
          v: 1,
          ocrResultId: row.id,
          fileId: row.fileId,
          entityId: row.entityId,
          mediaJobId: job.id,
          docType: "bank_receipt",
          status,
        },
        dedupeKey: `bank_receipt:${row.id}`,
      });
    },
  };
}
