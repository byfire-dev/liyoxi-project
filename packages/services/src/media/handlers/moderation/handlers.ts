import { z } from "@liyoxi/contract";
import type { MediaJob } from "@liyoxi/db";
import { lockRows } from "../../../kernel/index.js";
import type { Tx } from "../../../kernel/index.js";
import type { StorageBucket } from "../../../providers/types.js";
import type { BoundMediaDeps, FileRow } from "../../context.js";
import type { MediaJobHandler, JobOutcome } from "../../jobs/types.js";
import { moderationChannel } from "./channels.js";
import { recordModeration } from "./results.js";
const ref = z.strictObject({
  bucket: z.enum(["secure", "asset", "media", "pub"]),
  key: z.string().min(1).max(1024),
  etag: z.string().min(1).max(256).nullable().optional(),
});
const inputSchema = z.strictObject({
  src: ref,
  scenes: z.tuple([z.literal("profile")]),
  textSource: ref.extend({ fileId: z.uuid(), sizeBytes: z.string().regex(/^\d{1,5}$/) }).optional(),
});
const outputSchema = z.strictObject({
  verdict: z.enum(["pass", "review", "block"]),
  labels: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(16),
});
const failure = (code: string, retryable = true): JobOutcome => ({
  state: "failed",
  failure: { code, retryable, automaticRetry: false },
});
function claims(job: MediaJob) {
  const parsed = inputSchema.safeParse(job.input);
  return (
    job.subjectType === "file_object" &&
    job.parentId === null &&
    parsed.success &&
    (job.dedupeKey === `${job.kind}:${job.subjectId}:v1` ||
      (job.kind === "audit_text" &&
        job.dedupeKey === `audit_text:${job.subjectId}:text:${parsed.data.textSource?.fileId}`))
  );
}
export function createModerationHandlers(deps: BoundMediaDeps): readonly MediaJobHandler[] {
  const provider = deps.moderation;
  if (!provider) return [];
  async function files(tx: Tx, job: MediaJob): Promise<{ file: FileRow; text?: FileRow } | null> {
    const parsed = inputSchema.safeParse(job.input);
    if (!parsed.success || !claims(job)) return null;
    const input = parsed.data;
    await lockRows(
      tx,
      "file_object",
      [...new Set([job.subjectId, ...(input.textSource ? [input.textSource.fileId] : [])])].sort(),
    );
    const file = await tx.fileObject.findUnique({ where: { id: job.subjectId } });
    if (
      !file ||
      file.status !== "stored" ||
      file.moderationState !== "pending" ||
      file.bucket !== input.src.bucket ||
      file.objectKey !== input.src.key ||
      (input.src.etag !== undefined && file.etag !== input.src.etag)
    )
      return null;
    const kind = moderationChannel(file);
    if (kind !== job.kind && !(job.kind === "audit_image" && kind === "audit_image_wx"))
      return null;
    if (!input.textSource) return { file };
    const text = await tx.fileObject.findUnique({ where: { id: input.textSource.fileId } });
    if (
      !text ||
      text.status !== "stored" ||
      text.moderationState === "block" ||
      text.ext !== "txt" ||
      text.bucket !== input.textSource.bucket ||
      text.objectKey !== input.textSource.key ||
      text.etag !== input.textSource.etag ||
      text.sizeBytes?.toString() !== input.textSource.sizeBytes ||
      text.entityId !== file.entityId ||
      text.storeId !== file.storeId ||
      text.scopeType !== file.scopeType
    )
      return null;
    return { file, text };
  }
  const shared = {
    provider: provider.status,
    claims,
    validInput: (value: unknown) => inputSchema.safeParse(value).success,
    validOutput: (value: unknown) => outputSchema.safeParse(value).success,
    current: async (tx: Tx, job: MediaJob) => (await files(tx, job)) !== null,
    prepare: files,
    finish: async (
      tx: Tx,
      job: MediaJob,
      outcome: JobOutcome,
      ctx: Parameters<typeof recordModeration>[2],
    ) => {
      if (outcome.state !== "succeeded") return;
      const result = outputSchema.parse(outcome.output);
      await recordModeration(tx, deps, ctx, { fileId: job.subjectId, channel: "ci", ...result });
    },
  };
  const image: MediaJobHandler = {
    ...shared,
    kind: "audit_image",
    mode: "local",
    execute: async (job, _context, signal) => {
      const input = inputSchema.parse(job.input),
        result = await provider.audit({
          src: input.src,
          scenes: ["profile"],
          userData: `${job.id}:${job.attemptNo}`,
          signal,
        });
      return result.ok &&
        result.value.processed &&
        ["pass", "review", "block"].includes(result.value.verdict)
        ? {
            state: "succeeded",
            output: { verdict: result.value.verdict, labels: [...(result.value.labels ?? [])] },
          }
        : failure("CI_IMAGE_UNAVAILABLE");
    },
  };
  const text: MediaJobHandler = {
    ...shared,
    kind: "audit_text",
    mode: "local",
    execute: async (job, context, signal) => {
      const prepared = context as { text?: FileRow } | null;
      if (!prepared?.text) return failure("TEXT_NOT_EXTRACTED", false);
      const source = prepared.text;
      if (
        !source.etag ||
        source.sizeBytes === null ||
        source.sizeBytes <= 0n ||
        source.sizeBytes > 40000n
      )
        return failure("TEXT_AUDIT_LIMIT", false);
      const chunks: Uint8Array[] = [];
      const read = await deps.storage.readTo({
        bucket: source.bucket as StorageBucket,
        key: source.objectKey,
        expectedSize: Number(source.sizeBytes),
        maxBytes: 40000,
        ifMatchEtag: source.etag,
        signal,
        sink: async (chunk) => {
          chunks.push(chunk.slice());
        },
      });
      if (!read.ok) return failure("TEXT_READ_UNAVAILABLE");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return failure("TEXT_INVALID_UTF8", false);
      }
      if (!content || [...content].length > 10000) return failure("TEXT_AUDIT_LIMIT", false);
      const result = await provider.auditText({
        bucket: source.bucket as StorageBucket,
        text: content,
        userData: `${job.id}:${job.attemptNo}`,
        signal,
      });
      return result.ok && result.value.processed
        ? {
            state: "succeeded",
            output: { verdict: result.value.verdict, labels: [...(result.value.labels ?? [])] },
          }
        : failure("CI_TEXT_UNAVAILABLE");
    },
  };
  const video: MediaJobHandler = {
    ...shared,
    kind: "audit_video",
    mode: "remote",
    execute: async (job, _context, signal) => {
      const input = inputSchema.parse(job.input),
        result = await provider.auditVideo({
          src: input.src,
          userData: `${job.id}:${job.attemptNo}`,
          signal,
        });
      if (!result.ok && ["unconfigured", "unsupported", "rejected"].includes(result.reason))
        return failure("CI_VIDEO_UNAVAILABLE", false);
      if (
        !result.ok ||
        !result.value.processed ||
        result.value.dataId !== `${job.id}:${job.attemptNo}` ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(result.value.jobId)
      )
        return { state: "pending" };
      return { state: "submitted", externalJobId: result.value.jobId };
    },
    // No CI API supplies conclusive absence for an unknown submit; never resend that attempt.
    recover: async () => ({ state: "pending" }),
    canRetry: async (_tx, job) => job.externalJobId !== null && job.errorCode === "CI_VIDEO_FAILED",
    poll: async (job, signal) => {
      if (!job.externalJobId) return { state: "pending" };
      const input = inputSchema.parse(job.input),
        result = await provider.describeAudit({
          src: input.src,
          jobId: job.externalJobId,
          userData: `${job.id}:${job.attemptNo}`,
          signal,
        });
      if (
        !result.ok ||
        !result.value.processed ||
        result.value.jobId !== job.externalJobId ||
        result.value.dataId !== `${job.id}:${job.attemptNo}`
      )
        return { state: "pending" };
      if (result.value.state === "failed") return failure("CI_VIDEO_FAILED");
      if (result.value.state !== "succeeded" || !result.value.verdict) return { state: "pending" };
      return {
        state: "succeeded",
        output: { verdict: result.value.verdict, labels: [...(result.value.labels ?? [])] },
      };
    },
  };
  return [image, video, text];
}
