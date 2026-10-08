import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { StorageBucket } from "../providers/types.js";
import type { BoundMediaDeps } from "./context.js";
import { queueWechatImageAudit, runWechatImageAudit } from "./wechat-image-audit.js";
import { emitFile, notifyPromote } from "./upload.js";
export interface PromoteRef {
  readonly jobId: string;
}
export async function promote(deps: BoundMediaDeps, { jobId }: PromoteRef): Promise<void> {
  if (deps.wechatImage) {
    const kind = await deps.tx.run((tx) =>
      tx.mediaJob.findUnique({ where: { id: jobId }, select: { kind: true } }),
    );
    if (kind && ["audit_image_wx", "audit_image"].includes(kind.kind))
      return runWechatImageAudit(deps, jobId);
  }
  const owner = uuidv7();
  const claimed = await deps.tx.run(async (tx) => {
    await lockRows(tx, "media_job", [jobId]);
    const job = await tx.mediaJob.findUnique({ where: { id: jobId } });
    const now = deps.clock.now();
    if (
      !job ||
      job.kind !== "promote" ||
      !["queued", "running"].includes(job.state) ||
      job.nextRunAt > now
    )
      return null;
    await lockRows(tx, "file_object", [job.subjectId]);
    const file = await tx.fileObject.findUnique({ where: { id: job.subjectId } });
    if (!file || file.status !== "promoting") return null;
    if (job.attemptNo >= job.maxAttempts || job.deadlineAt <= now) {
      await tx.mediaJob.updateMany({
        where: { id: job.id, state: job.state, attemptNo: job.attemptNo },
        data: {
          state: "failed",
          finishedAt: now,
          errorCode: "PROMOTE_EXHAUSTED",
          errorMessage: "入库任务已超过尝试次数或期限",
          updatedAt: now,
        },
      });
      await reject(tx, deps, file.id, "copy_verify_failed");
      return null;
    }
    const changed = await tx.mediaJob.updateMany({
      where: { id: job.id, state: job.state, attemptNo: job.attemptNo, nextRunAt: { lte: now } },
      data: {
        state: "running",
        attemptNo: { increment: 1 },
        leaseOwner: owner,
        nextRunAt: new Date(now.getTime() + 30_000),
        startedAt: job.startedAt ?? now,
        updatedAt: now,
      },
    });
    return changed.count === 1
      ? { file, attempt: job.attemptNo + 1, maxAttempts: job.maxAttempts }
      : null;
  });
  if (!claimed) return;
  const { file } = claimed;
  let outcome: { etag: string; size: number } | { reason: string; retryable: boolean };
  const copied = await deps.storage.copy({
    src: { bucket: file.incomingBucket as StorageBucket, key: file.incomingKey! },
    dst: { bucket: file.bucket as StorageBucket, key: file.objectKey },
    ifMatchEtag: file.incomingEtag!,
    contentType: file.declaredMime,
    contentDisposition: "attachment",
  });
  if (!copied.ok)
    outcome = {
      reason: copied.reason === "rejected" ? "changed_after_confirm" : "PROVIDER_UNAVAILABLE",
      retryable: copied.reason !== "rejected",
    };
  else {
    const checked = await deps.storage.head({
      bucket: file.bucket as StorageBucket,
      key: file.objectKey,
    });
    if (!checked.ok || !Number.isSafeInteger(checked.value.size) || checked.value.size < 0)
      outcome = { reason: "PROVIDER_UNAVAILABLE", retryable: true };
    else if (
      !checked.value.exists ||
      BigInt(checked.value.size) !== file.declaredSize ||
      !copied.value.etag ||
      checked.value.etag !== copied.value.etag
    )
      outcome = { reason: "copy_verify_failed", retryable: false };
    else outcome = { etag: copied.value.etag, size: checked.value.size };
  }
  const auditId = await deps.tx.run(async (tx) => {
    await lockRows(tx, "media_job", [jobId]);
    const job = await tx.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
    // 租约过期、重领或取消后的旧外呼结果不能覆盖当前尝试。
    if (
      job.state !== "running" ||
      job.attemptNo !== claimed.attempt ||
      job.leaseOwner !== owner ||
      job.nextRunAt <= deps.clock.now()
    )
      return;
    await lockRows(tx, "file_object", [file.id]);
    const current = await tx.fileObject.findUniqueOrThrow({ where: { id: file.id } });
    if (current.status !== "promoting") return;
    const now = deps.clock.now();
    if ("etag" in outcome) {
      const changed = await tx.fileObject.updateMany({
        where: { id: file.id, status: "promoting", incomingEtag: file.incomingEtag },
        data: {
          status: "stored",
          incomingKey: null,
          confirmingUntil: null,
          sizeBytes: BigInt(outcome.size),
          mime: file.declaredMime,
          etag: outcome.etag,
          storedAt: now,
          updatedAt: now,
        },
      });
      if (changed.count !== 1) throw new AppError("STATE_NOT_ALLOWED");
      await tx.mediaJob.updateMany({
        where: { id: jobId, state: "running", attemptNo: claimed.attempt, leaseOwner: owner },
        data: {
          state: "succeeded",
          output: { etag: outcome.etag, sizeBytes: outcome.size.toString() },
          finishedAt: now,
          errorCode: null,
          errorMessage: null,
          isRetryable: false,
          updatedAt: now,
        },
      });
      await emitFile(
        tx,
        deps,
        { identity: createIdentityContext({ actor: { type: "system", job: "media.promote" } }) },
        current,
        "file.stored",
      );
      return queueWechatImageAudit(tx, deps, {
        ...current,
        status: "stored",
        sizeBytes: BigInt(outcome.size),
      });
    } else {
      const retry = outcome.retryable && job.attemptNo < job.maxAttempts;
      await tx.mediaJob.updateMany({
        where: { id: jobId, state: "running", attemptNo: claimed.attempt, leaseOwner: owner },
        data: {
          state: retry ? "queued" : "failed",
          nextRunAt: new Date(now.getTime() + 30_000),
          finishedAt: retry ? null : now,
          errorCode: outcome.reason,
          errorMessage: "文件入库复制或核对未完成",
          isRetryable: outcome.retryable,
          updatedAt: now,
        },
      });
      if (!retry)
        await reject(tx, deps, file.id, outcome.retryable ? "copy_verify_failed" : outcome.reason);
    }
  });
  if (auditId) await notifyPromote(deps, auditId);
}
async function reject(
  tx: Parameters<typeof lockRows>[0],
  deps: BoundMediaDeps,
  fileId: string,
  reason: string,
) {
  const changed = await tx.fileObject.updateMany({
    where: { id: fileId, status: "promoting" },
    data: { status: "rejected", rejectReason: reason, updatedAt: deps.clock.now() },
  });
  if (changed.count === 1)
    await emitFile(
      tx,
      deps,
      { identity: createIdentityContext({ actor: { type: "system", job: "media.promote" } }) },
      await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }),
      "file.rejected",
    );
}
/** 消费者的补偿扫描，不登记新的进程循环。Redis 丢唤醒不丢任务事实。 */
export async function scanPromote(deps: BoundMediaDeps): Promise<number> {
  const now = deps.clock.now();
  const jobs = await deps.tx.run((tx) =>
    tx.mediaJob.findMany({
      where: {
        kind: deps.wechatImage ? { in: ["promote", "audit_image_wx", "audit_image"] } : "promote",
        OR: [
          {
            state: "queued",
            createdAt: { lte: new Date(now.getTime() - 30_000) },
            nextRunAt: { lte: now },
          },
          { state: "running", nextRunAt: { lte: now } },
          ...(deps.wechatImage
            ? [{ state: { in: ["submitting", "submitted"] }, nextRunAt: { lte: now } }]
            : []),
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 500,
    }),
  );
  for (const job of jobs) await notifyPromote(deps, job.id);
  return jobs.length;
}
