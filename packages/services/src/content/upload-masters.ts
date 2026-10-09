import type { UploadBatch } from "@liyoxi/db";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Events } from "../events/index.js";

/** Caller holds drama140, batch380 and all old/new file410 rows in sorted order. */
export async function commitUploadMasters(
  tx: Tx,
  deps: { clock: Clock; media: Pick<Media, "link" | "release">; events: Pick<Events, "emit"> },
  input: {
    batch: UploadBatch;
    staffId: string;
    identity: IdentityContext;
    items: readonly { episodeNo: number; fileId: string; durationMs: number | null }[];
  },
) {
  const now = deps.clock.now(),
    drama = await tx.drama.findUnique({ where: { id: input.batch.targetId } });
  if (!drama) throw new AppError("NOT_FOUND");
  if (drama.archivedAt) throw new AppError("DRAMA_ARCHIVED");
  if (drama.totalEpisodes !== input.batch.expectedCount) throw new AppError("PRECONDITION_CHANGED");
  const result: { episodeNo: number; dramaEpisodeMasterId: string; revNo: number }[] = [];
  for (const item of [...input.items].sort((a, b) => a.episodeNo - b.episodeNo)) {
    const old = await tx.dramaEpisodeMaster.findFirst({
      where: { dramaId: drama.id, episodeNo: item.episodeNo, isCurrent: true },
    });
    const max = await tx.dramaEpisodeMaster.aggregate({
      where: { dramaId: drama.id, episodeNo: item.episodeNo },
      _max: { revNo: true },
    });
    if (old)
      await tx.dramaEpisodeMaster.update({
        where: { id: old.id },
        data: { isCurrent: false, state: "superseded", updatedAt: now },
      });
    const id = uuidv7(),
      revNo = (max._max.revNo ?? 0) + 1;
    await tx.dramaEpisodeMaster.create({
      data: {
        id,
        dramaId: drama.id,
        episodeNo: item.episodeNo,
        revNo,
        fileId: item.fileId,
        state: "ready",
        isCurrent: true,
        durationMs: item.durationMs,
        uploadBatchId: input.batch.id,
        replaceReason: input.batch.replaceReason,
        isContentChanged: input.batch.isContentChanged,
        createdByStaffId: input.staffId,
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await deps.media.link(tx, {
      fileId: item.fileId,
      entityId: null,
      storeId: null,
      refType: "drama_episode_master",
      refId: id,
      role: "main",
    });
    if (old)
      await deps.media.release(tx, {
        fileId: old.fileId,
        entityId: null,
        storeId: null,
        refType: "drama_episode_master",
        refId: old.id,
        role: "main",
        keepUntil: new Date(now.getTime() + 180 * 86_400_000),
      });
    await deps.media.release(tx, {
      fileId: item.fileId,
      entityId: null,
      storeId: null,
      refType: "upload_batch",
      refId: input.batch.id,
      role: "main",
      keepUntil: now,
    });
    result.push({ episodeNo: item.episodeNo, dramaEpisodeMasterId: id, revNo });
  }
  await deps.events.emit(tx, input.identity, {
    type: "drama.masters_changed",
    aggregate: { type: "drama", id: drama.id },
    dedupeKey: input.batch.id,
    payload: {
      v: 1,
      dramaId: drama.id,
      uploadBatchId: input.batch.id,
      episodeNos: result.map((r) => r.episodeNo),
      isContentChanged: input.batch.isContentChanged,
    },
  });
  return result;
}
