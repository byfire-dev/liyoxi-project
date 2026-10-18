import { isUuid, lockRows } from "../../kernel/index.js";
import type { Clock, Tx } from "../../kernel/index.js";
import type { MediaJobHandler } from "../jobs/types.js";

/** Wake only current owner facts; callback text/status is never a recognition result. */
export async function wakeAssetAsrJob(
  tx: Tx,
  input: { mediaJobId: string; externalJobId: string },
  clock: Clock,
  handler: MediaJobHandler | undefined,
): Promise<"processed" | "ignored"> {
  if (!isUuid(input.mediaJobId) || !handler || handler.provider === "unconfigured")
    return "ignored";
  const candidate = await tx.mediaJob.findUnique({
    where: { id: input.mediaJobId },
    select: { parentType: true, parentId: true },
  });
  if (candidate?.parentType !== "store_asset" || !candidate.parentId) return "ignored";
  // The read above is only a lock-order hint. All facts are read again under parent -> job locks.
  await lockRows(tx, "store_asset", [candidate.parentId]);
  await lockRows(tx, "media_job", [input.mediaJobId]);
  const job = await tx.mediaJob.findUnique({ where: { id: input.mediaJobId } });
  const now = clock.now();
  if (
    !job ||
    job.parentType !== "store_asset" ||
    job.parentId !== candidate.parentId ||
    job.kind !== "asr" ||
    job.mode !== "remote" ||
    job.state !== "submitted" ||
    job.provider !== handler.provider ||
    job.externalJobId !== input.externalJobId ||
    job.attemptNo < 1 ||
    job.deadlineAt <= now ||
    !(await handler.current(tx, job)) ||
    !(await handler.current(tx, job))
  )
    return "ignored";
  // current() takes file locks (410); re-read after a competing file writer has released them.
  await tx.mediaJob.update({
    where: { id: job.id },
    data: { nextRunAt: now, updatedAt: now },
  });
  return "processed";
}
