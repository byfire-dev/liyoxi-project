import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { MediaJob } from "@liyoxi/db";
import type { StorageBucket, ContentCheckOutcome } from "../providers/types.js";
import type { BoundMediaDeps, FileRow } from "./context.js";
import { notifyPromote } from "./upload.js";

export interface WechatImageResultInput {
  traceId: string;
  result: { suggest: "pass" | "review" | "risky"; label: number };
  receivedAt: Date;
}
const WX_DEADLINE = 35 * 60_000;
const CI_DEADLINE = 15 * 60_000;
const LEASE = 2 * 60_000;
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
const currentFile = (job: MediaJob, file: FileRow | null): file is FileRow => {
  const src = (job.input as { src?: { bucket?: unknown; key?: unknown } })?.src;
  return (
    file !== null &&
    job.subjectType === "file_object" &&
    job.parentId === null &&
    job.dedupeKey === `${job.kind}:${file.id}:v1` &&
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
export async function runWechatImageAudit(deps: BoundMediaDeps, jobId: string): Promise<void> {
  const binding = deps.wechatImage;
  if (!binding) return;
  const owner = uuidv7();
  const claim = await deps.tx.run(async (tx) => {
    await lockRows(tx, "media_job", [jobId]);
    const job = await tx.mediaJob.findUnique({ where: { id: jobId } });
    const now = deps.clock.now();
    if (
      !job ||
      !["audit_image_wx", "audit_image"].includes(job.kind) ||
      job.dedupeKey !== `${job.kind}:${job.subjectId}:v1` ||
      (job.kind === "audit_image_wx"
        ? job.provider !== "wechat" || job.mode !== "remote"
        : job.provider !== binding.fallback.status || job.mode !== "local") ||
      !["queued", "running", "submitting", "submitted"].includes(job.state) ||
      job.nextRunAt > now
    )
      return null;
    await lockRows(tx, "file_object", [job.subjectId]);
    const file = await tx.fileObject.findUnique({ where: { id: job.subjectId } });
    if (!currentFile(job, file)) {
      await tx.mediaJob.update({
        where: { id: job.id },
        data: { state: "canceled", finishedAt: now, leaseOwner: null, updatedAt: now },
      });
      return null;
    }
    if (
      job.kind === "audit_image_wx" &&
      (job.state === "submitted" ||
        job.state === "submitting" ||
        job.deadlineAt <= now ||
        job.attemptNo >= job.maxAttempts)
    )
      return { wake: await fallback(tx, deps, job, file, "WX_IMAGE_TIMEOUT") };
    if (job.deadlineAt <= now || job.attemptNo >= job.maxAttempts) {
      await tx.mediaJob.update({
        where: { id: job.id },
        data: {
          state: "failed",
          finishedAt: now,
          errorCode: "IMAGE_AUDIT_EXHAUSTED",
          errorMessage: "Image audit deadline or attempts exhausted",
          updatedAt: now,
        },
      });
      return null;
    }
    const identity =
      job.kind === "audit_image_wx" &&
      binding.appid &&
      binding.provider.configured &&
      file.uploadActorId
        ? await binding.recentWechatOpenid(tx, {
            merchantUserId: file.uploadActorId,
            appid: binding.appid,
            now,
          })
        : null;
    if (job.kind === "audit_image_wx" && !identity)
      return { wake: await fallback(tx, deps, job, file, "WX_IMAGE_IDENTITY_UNAVAILABLE") };
    await tx.mediaJob.update({
      where: { id: job.id },
      data: {
        state: job.kind === "audit_image_wx" ? "submitting" : "running",
        attemptNo: { increment: 1 },
        leaseOwner: owner,
        nextRunAt: new Date(now.getTime() + LEASE),
        startedAt: job.startedAt ?? now,
        updatedAt: now,
      },
    });
    return { job, file, identity, attempt: job.attemptNo + 1 };
  });
  if (!claim) return;
  if ("wake" in claim) {
    await notifyPromote(deps, claim.wake!);
    return;
  }
  let outcome: { ok: true; value: ContentCheckOutcome } | { ok: false } = { ok: false };
  if (claim.job.kind === "audit_image_wx") {
    const signed = await deps.storage.presignGet({
      bucket: claim.file.bucket as StorageBucket,
      key: claim.file.objectKey,
      expiresSec: 3600,
      disposition: "inline",
    });
    if (signed.ok)
      outcome = await binding.provider.checkImage({
        openid: claim.identity!.openid,
        scene: "profile",
        mediaUrl: signed.value.url,
      });
  } else {
    const audited = await binding.fallback.audit({
      src: { bucket: claim.file.bucket as StorageBucket, key: claim.file.objectKey },
      scenes: ["profile"],
      userData: `${claim.job.id}:${claim.attempt}`,
    });
    if (
      audited.ok &&
      audited.value.processed &&
      ["pass", "review", "block"].includes(audited.value.verdict)
    )
      outcome = { ok: true, value: { verdict: audited.value.verdict } };
  }
  const wake = await deps.tx.run(async (tx) => {
    await lockRows(tx, "media_job", [jobId]);
    const job = await tx.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
    const now = deps.clock.now();
    if (
      job.state !== (claim.job.kind === "audit_image_wx" ? "submitting" : "running") ||
      job.attemptNo !== claim.attempt ||
      job.leaseOwner !== owner ||
      job.nextRunAt <= now
    )
      return null;
    await lockRows(tx, "file_object", [job.subjectId]);
    const file = await tx.fileObject.findUnique({ where: { id: job.subjectId } });
    if (!currentFile(job, file)) {
      await tx.mediaJob.update({
        where: { id: job.id },
        data: { state: "canceled", finishedAt: now, leaseOwner: null, updatedAt: now },
      });
      return null;
    }
    if (job.kind === "audit_image_wx") {
      if (!outcome.ok || outcome.value.verdict !== "pending" || !outcome.value.traceId)
        return fallback(tx, deps, job, file, "WX_IMAGE_SUBMIT_FAILED");
      await tx.mediaJob.update({
        where: { id: job.id },
        data: {
          state: "submitted",
          externalJobId: outcome.value.traceId,
          nextRunAt: job.deadlineAt,
          leaseOwner: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        },
      });
    } else if (outcome.ok) {
      await tx.mediaJob.update({
        where: { id: job.id },
        data: {
          state: "succeeded",
          finishedAt: now,
          leaseOwner: null,
          output: { verdict: outcome.value.verdict },
          updatedAt: now,
        },
      });
      await tx.fileObject.update({
        where: { id: file.id },
        data: {
          moderationState: outcome.value.verdict,
          moderationDetail: {
            channel: "ci",
            verdict: outcome.value.verdict,
            decidedAt: now.toISOString(),
          },
          updatedAt: now,
        },
      });
    } else
      await tx.mediaJob.update({
        where: { id: job.id },
        data: {
          state: "failed",
          finishedAt: now,
          leaseOwner: null,
          errorCode: "CI_IMAGE_UNAVAILABLE",
          errorMessage: "CI image audit not processed",
          isRetryable: true,
          updatedAt: now,
        },
      });
    return null;
  });
  if (wake) await notifyPromote(deps, wake);
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
