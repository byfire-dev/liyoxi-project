import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { MediaJob } from "@liyoxi/db";
import type { StorageBucket } from "../providers/types.js";
import type { BoundMediaDeps, FileRow } from "./context.js";
import type { MediaJobHandler } from "./jobs/types.js";

export interface WechatImageResultInput {
  traceId: string;
  result: { suggest: "pass" | "review" | "risky"; label: number };
  receivedAt: Date;
}
const WX_DEADLINE = 35 * 60_000;
const CI_DEADLINE = 15 * 60_000;
const categories = [
  "profile_image",
  "profile_promo",
  "store_asset",
  "channel_screenshot",
  "ticket_attachment",
];
const eligible = (file: FileRow) =>
  file.uploadActorType === "merchant" &&
  file.uploadClient === "weapp" &&
  categories.includes(file.category) &&
  ["jpg", "jpeg", "png"].includes(file.ext) &&
  file.sizeBytes !== null &&
  file.sizeBytes <= 5n * 1024n * 1024n;

/** Called only in the successful promotion TX, before its postcommit wake. */
export async function queueWechatImageAudit(
  tx: Tx,
  deps: BoundMediaDeps,
  file: FileRow,
): Promise<string | null> {
  if (!deps.wechatImage || !eligible(file) || file.moderationState !== "none") return null;
  const now = deps.clock.now();
  const id = uuidv7();
  await tx.mediaJob.createMany({
    data: [
      {
        id,
        kind: "audit_image_wx",
        provider: "wechat",
        mode: "remote",
        subjectType: "file_object",
        subjectId: file.id,
        dedupeKey: `audit_image_wx:${file.id}:v1`,
        state: "queued",
        input: { src: { bucket: file.bucket, key: file.objectKey }, scenes: ["profile"] },
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + WX_DEADLINE),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  await tx.fileObject.updateMany({
    where: { id: file.id, status: "stored", moderationState: "none" },
    data: { moderationState: "pending", updatedAt: now },
  });
  return id;
}
async function fallback(
  tx: Tx,
  deps: BoundMediaDeps,
  job: MediaJob,
  file: FileRow,
  reason: string,
): Promise<string> {
  const now = deps.clock.now();
  await tx.mediaJob.update({
    where: { id: job.id },
    data: {
      state: "failed",
      finishedAt: now,
      errorCode: reason,
      errorMessage: "Wechat image audit unavailable; CI fallback pending",
      isRetryable: false,
      leaseOwner: null,
      updatedAt: now,
    },
  });
  const id = uuidv7();
  await tx.mediaJob.createMany({
    data: [
      {
        id,
        kind: "audit_image",
        provider: deps.wechatImage!.fallback.status,
        mode: "local",
        subjectType: "file_object",
        subjectId: file.id,
        dedupeKey: `audit_image:${file.id}:v1`,
        state: "queued",
        input: { src: { bucket: file.bucket, key: file.objectKey }, scenes: ["profile"] },
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + CI_DEADLINE),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  const next = await tx.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `audit_image:${file.id}:v1` },
  });
  return next.id;
}
const claimsFileAudit = (job: MediaJob): boolean =>
  job.subjectType === "file_object" &&
  job.parentId === null &&
  job.dedupeKey === `${job.kind}:${job.subjectId}:v1`;
const currentFile = (job: MediaJob, file: FileRow | null): file is FileRow => {
  const src = (job.input as { src?: { bucket?: unknown; key?: unknown } })?.src;
  return (
    file !== null &&
    claimsFileAudit(job) &&
    file.id === job.subjectId &&
    (job.kind === "audit_image_wx"
      ? job.provider === "wechat" && job.mode === "remote"
      : job.kind === "audit_image" && job.mode === "local") &&
    file.status === "stored" &&
    file.moderationState === "pending" &&
    eligible(file) &&
    src?.bucket === file.bucket &&
    src.key === file.objectKey
  );
};
const auditInput = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as { src?: { bucket?: unknown; key?: unknown }; scenes?: unknown };
  return (
    Object.keys(input).length === 2 &&
    Object.keys(input).every((key) => ["src", "scenes"].includes(key)) &&
    input.src !== null &&
    typeof input.src === "object" &&
    !Array.isArray(input.src) &&
    Object.keys(input.src).length === 2 &&
    ["secure", "asset", "media", "pub"].includes(String(input.src.bucket)) &&
    typeof input.src.key === "string" &&
    Buffer.byteLength(input.src.key) <= 1024 &&
    input.src.key.length > 0 &&
    !/\p{Cc}/u.test(input.src.key) &&
    Array.isArray(input.scenes) &&
    input.scenes.length === 1 &&
    input.scenes[0] === "profile"
  );
};
const auditOutput = (value: unknown): value is { verdict: "pass" | "review" | "block" } =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  ["pass", "review", "block"].includes((value as { verdict: string }).verdict);

export function createWechatImageHandlers(deps: BoundMediaDeps): readonly MediaJobHandler[] {
  const binding = deps.wechatImage;
  if (!binding) return [];
  const current: MediaJobHandler["current"] = async (tx, job) => {
    await lockRows(tx, "file_object", [job.subjectId]);
    return currentFile(job, await tx.fileObject.findUnique({ where: { id: job.subjectId } }));
  };
  const wx: MediaJobHandler = {
    kind: "audit_image_wx",
    provider: "wechat",
    mode: "remote",
    claims: claimsFileAudit,
    validInput: auditInput,
    validOutput: () => false,
    current,
    prepare: async (tx, job) => {
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } });
      const identity =
        binding.appid && binding.provider.configured && file.uploadActorId
          ? await binding.recentWechatOpenid(tx, {
              merchantUserId: file.uploadActorId,
              appid: binding.appid,
              now: deps.clock.now(),
            })
          : null;
      return { file, identity };
    },
    execute: async (_job, context, signal) => {
      const { file, identity } = context as { file: FileRow; identity: { openid: string } | null };
      if (!identity)
        return {
          state: "failed",
          failure: { code: "WX_IMAGE_IDENTITY_UNAVAILABLE", retryable: false },
        };
      if (signal.aborted) return { state: "pending" };
      const signed = await deps.storage.presignGet({
        bucket: file.bucket as StorageBucket,
        key: file.objectKey,
        expiresSec: 3600,
        disposition: "inline",
      });
      if (!signed.ok || signal.aborted)
        return { state: "failed", failure: { code: "WX_IMAGE_SUBMIT_FAILED", retryable: false } };
      const result = await binding.provider.checkImage({
        openid: identity.openid,
        scene: "profile",
        mediaUrl: signed.value.url,
        signal,
      });
      if (!result.ok || result.value.verdict !== "pending" || !result.value.traceId)
        return { state: "failed", failure: { code: "WX_IMAGE_SUBMIT_FAILED", retryable: false } };
      return {
        state: "submitted",
        externalJobId: result.value.traceId,
        nextRunAt: _job.deadlineAt,
      };
    },
    recover: async () => ({
      state: "failed",
      failure: { code: "WX_IMAGE_TIMEOUT", retryable: false },
    }),
    poll: async () => ({ state: "pending" }),
    finish: async (tx, job) => {
      if (job.state !== "failed") return;
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } });
      const reason =
        job.errorCode === "MEDIA_JOB_EXHAUSTED" || job.errorCode === "MEDIA_JOB_DEADLINE"
          ? "WX_IMAGE_TIMEOUT"
          : (job.errorCode ?? "WX_IMAGE_SUBMIT_FAILED");
      return [await fallback(tx, deps, job, file, reason)];
    },
  };
  const ci: MediaJobHandler = {
    kind: "audit_image",
    provider: binding.fallback.status,
    mode: "local",
    claims: claimsFileAudit,
    validInput: auditInput,
    validOutput: auditOutput,
    current,
    execute: async (job, _context, signal) => {
      const src = (job.input as { src: { bucket: StorageBucket; key: string } }).src;
      const result = await binding.fallback.audit({
        src,
        scenes: ["profile"],
        userData: `${job.id}:${job.attemptNo}`,
        signal,
      });
      if (
        !result.ok ||
        !result.value.processed ||
        !["pass", "review", "block"].includes(result.value.verdict)
      )
        return {
          state: "failed",
          failure: { code: "CI_IMAGE_UNAVAILABLE", retryable: true, automaticRetry: false },
        };
      return { state: "succeeded", output: { verdict: result.value.verdict } };
    },
    finish: async (tx, job, outcome) => {
      if (outcome.state !== "succeeded" || !auditOutput(outcome.output)) return;
      const now = deps.clock.now();
      await tx.fileObject.update({
        where: { id: job.subjectId },
        data: {
          moderationState: outcome.output.verdict,
          moderationDetail: {
            channel: "ci",
            verdict: outcome.output.verdict,
            decidedAt: now.toISOString(),
          },
          updatedAt: now,
        },
      });
    },
  };
  return [wx, ci];
}
export async function applyWechatImageResult(
  deps: BoundMediaDeps,
  tx: Tx,
  input: WechatImageResultInput,
  _ctx: IdentityContext,
): Promise<"processed" | "ignored"> {
  if (
    !input.traceId ||
    !["pass", "review", "risky"].includes(input.result.suggest) ||
    !Number.isFinite(input.result.label)
  )
    throw new AppError("WEBHOOK_PAYLOAD_INVALID");
  const matches = await tx.mediaJob.findMany({
    where: { kind: "audit_image_wx", provider: "wechat", externalJobId: input.traceId },
    select: { id: true },
    take: 2,
  });
  if (matches.length !== 1) throw new AppError("BUSY");
  await lockRows(tx, "media_job", [matches[0]!.id]);
  const job = await tx.mediaJob.findUniqueOrThrow({ where: { id: matches[0]!.id } });
  if (job.state !== "submitted") {
    if (["queued", "running", "submitting"].includes(job.state)) throw new AppError("BUSY");
    return "ignored";
  }
  await lockRows(tx, "file_object", [job.subjectId]);
  const file = await tx.fileObject.findUnique({ where: { id: job.subjectId } });
  if (job.externalJobId !== input.traceId || !currentFile(job, file)) return "ignored";
  const now = deps.clock.now();
  const verdict = input.result.suggest === "risky" ? "block" : input.result.suggest;
  await tx.mediaJob.update({
    where: { id: job.id },
    data: {
      state: "succeeded",
      finishedAt: now,
      leaseOwner: null,
      output: {
        suggest: input.result.suggest,
        label: input.result.label,
        receivedAt: input.receivedAt.toISOString(),
      },
      updatedAt: now,
    },
  });
  await tx.fileObject.update({
    where: { id: file.id },
    data: {
      moderationState: verdict,
      moderationDetail: {
        channel: "wechat",
        verdict,
        traceId: input.traceId,
        labels: [String(input.result.label)],
        decidedAt: now.toISOString(),
      },
      updatedAt: now,
    },
  });
  return "processed";
}
