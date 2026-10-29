import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import { enqueueSampleWatermark } from "./production-playables.js";

/** Caller holds delivery parent locks. Never rewrites QC, source facts or a terminal job. */
export async function ensureSampleWatermark(deps: BoundMediaDeps, tx: Tx, fileId: string) {
  if (deps.production?.mode !== "local_sample_watermark")
    throw new AppError("PROVIDER_UNAVAILABLE");
  const before = await tx.playableAsset.findMany({
    where: { kind: "sample", sourceFileId: fileId },
    select: { id: true },
  });
  await lockRows(
    tx,
    "playable_asset",
    before.map((row) => row.id),
  );
  await lockRows(tx, "production_record", [fileId]);
  // Recheck after the source parent lock; a competing creator may have installed an asset.
  const current = await tx.playableAsset.findMany({
    where: { kind: "sample", sourceFileId: fileId },
    select: { id: true },
  });
  if (current.some((row) => !before.some((old) => old.id === row.id))) throw new AppError("BUSY");
  const jobs = await tx.mediaJob.findMany({
    where: { kind: "watermark_sample", subjectId: fileId },
    select: { id: true },
  });
  await lockRows(
    tx,
    "media_job",
    jobs.map((row) => row.id),
  );
  await lockRows(tx, "file_object", [fileId]);
  const jobId = await enqueueSampleWatermark(deps, tx, fileId);
  const job = await tx.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
  // A failed job must use the existing audited retry action; do not reset its attempt budget here.
  if (job.mode !== "local" || job.state === "failed" || job.state === "canceled")
    throw new AppError("MEDIA_JOB_NOT_RETRYABLE");
  return jobId;
}
