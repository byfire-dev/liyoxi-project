import { AppError, lockRows } from "../kernel/index.js";
import type { StorageBucket } from "../providers/types.js";
import type { BoundMediaDeps, FileRow } from "./context.js";
import type { MediaJobHandler } from "./jobs/types.js";
import { queueWechatImageAudit } from "./wechat-image-audit.js";
import { emitFile } from "./upload.js";

export interface PromoteRef {
  readonly jobId: string;
}
type StoredCopy = { etag: string; sizeBytes: string; crc64: string | null };
const output = (value: unknown): value is StoredCopy => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const one = value as StoredCopy;
  return (
    typeof one.etag === "string" &&
    one.etag.length > 0 &&
    one.etag.length <= 256 &&
    typeof one.sizeBytes === "string" &&
    /^\d{1,20}$/.test(one.sizeBytes) &&
    (one.crc64 === null || (typeof one.crc64 === "string" && /^\d{1,20}$/.test(one.crc64)))
  );
};

/** File-object decisions stay in the same guarded job-result transaction. */
export function createPromoteHandler(deps: BoundMediaDeps): MediaJobHandler {
  return {
    kind: "promote",
    mode: "local",
    provider: "local",
    validInput: (input) =>
      input !== null &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      Object.keys(input).length === 0,
    validOutput: output,
    current: async (tx, job) => {
      await lockRows(tx, "file_object", [job.subjectId]);
      const file = await tx.fileObject.findUnique({ where: { id: job.subjectId } });
      return (
        job.subjectType === "file_object" &&
        job.parentId === null &&
        job.dedupeKey === `promote:${job.subjectId}` &&
        file?.status === "promoting" &&
        file.incomingKey !== null &&
        file.incomingEtag !== null
      );
    },
    prepare: (tx, job) => tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } }),
    execute: async (_job, context, signal) => {
      const file = context as FileRow;
      const copied = await deps.storage.copy({
        src: { bucket: file.incomingBucket as StorageBucket, key: file.incomingKey! },
        dst: { bucket: file.bucket as StorageBucket, key: file.objectKey },
        ifMatchEtag: file.incomingEtag!,
        contentType: file.declaredMime,
        contentDisposition: "attachment",
        signal,
      });
      if (!copied.ok)
        return {
          state: "failed",
          failure: {
            code: copied.reason === "rejected" ? "changed_after_confirm" : "PROVIDER_UNAVAILABLE",
            retryable: copied.reason !== "rejected",
          },
        };
      const checked = await deps.storage.head({
        bucket: file.bucket as StorageBucket,
        key: file.objectKey,
        signal,
      });
      if (!checked.ok || !Number.isSafeInteger(checked.value.size) || checked.value.size < 0)
        return { state: "failed", failure: { code: "PROVIDER_UNAVAILABLE", retryable: true } };
      if (
        !checked.value.exists ||
        BigInt(checked.value.size) !== file.declaredSize ||
        !copied.value.etag ||
        copied.value.etag !== checked.value.etag ||
        (file.incomingCrc64 !== null && checked.value.crc64 !== file.incomingCrc64)
      )
        return { state: "failed", failure: { code: "copy_verify_failed", retryable: false } };
      return {
        state: "succeeded",
        output: {
          etag: copied.value.etag,
          sizeBytes: checked.value.size.toString(),
          crc64: checked.value.crc64 ?? null,
        },
      };
    },
    finish: async (tx, job, outcome, ctx) => {
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } });
      const now = deps.clock.now();
      if (outcome.state === "succeeded" && output(outcome.output)) {
        const changed = await tx.fileObject.updateMany({
          where: { id: file.id, status: "promoting", incomingEtag: file.incomingEtag },
          data: {
            status: "stored",
            incomingKey: null,
            confirmingUntil: null,
            sizeBytes: BigInt(outcome.output.sizeBytes),
            mime: file.declaredMime,
            etag: outcome.output.etag,
            crc64: outcome.output.crc64,
            storedAt: now,
            updatedAt: now,
          },
        });
        if (changed.count !== 1) throw new AppError("STATE_NOT_ALLOWED");
        await emitFile(tx, deps, { identity: ctx }, file, "file.stored");
        const next = await queueWechatImageAudit(tx, deps, {
          ...file,
          status: "stored",
          sizeBytes: BigInt(outcome.output.sizeBytes),
        });
        const probe = await deps.queueProbe?.(tx, {
          ...file,
          status: "stored",
          etag: outcome.output.etag,
          sizeBytes: BigInt(outcome.output.sizeBytes),
        });
        return [next, probe].filter((id): id is string => !!id);
      }
      if (job.state === "failed") {
        const reason =
          job.errorCode === "changed_after_confirm"
            ? "changed_after_confirm"
            : "copy_verify_failed";
        const changed = await tx.fileObject.updateMany({
          where: { id: file.id, status: "promoting" },
          data: { status: "rejected", rejectReason: reason, updatedAt: now },
        });
        if (changed.count)
          await emitFile(
            tx,
            deps,
            { identity: ctx },
            await tx.fileObject.findUniqueOrThrow({ where: { id: file.id } }),
            "file.rejected",
          );
      }
    },
  };
}
