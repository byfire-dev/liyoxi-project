import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export async function readMasterProductionFacts(tx: Tx, masterId: string) {
  const master = await tx.dramaEpisodeMaster.findUnique({
    where: { id: masterId },
    select: {
      id: true,
      isCurrent: true,
      file: {
        select: {
          mediaInfo: {
            select: { durationMs: true, displayWidth: true, displayHeight: true },
          },
        },
      },
    },
  });
  const info = master?.file.mediaInfo;
  if (!master || !info?.durationMs || !info.displayWidth || !info.displayHeight) return null;
  return {
    id: master.id,
    isCurrent: master.isCurrent,
    durationMs: info.durationMs,
    displayWidth: info.displayWidth,
    displayHeight: info.displayHeight,
  };
}

export async function readTrailerMediaFacts(tx: Tx, dramaId: string) {
  const drama = await tx.drama.findUnique({
    where: { id: dramaId },
    select: { id: true, archivedAt: true, isAiGenerated: true, posterFileId: true },
  });
  if (!drama || drama.archivedAt) return null;
  const pointer = await tx.dramaTrailer.findUnique({
    where: { dramaId },
    select: { targetPlayableAssetId: true, currentPlayableAssetId: true },
  });
  return {
    dramaId,
    isAiGenerated: drama.isAiGenerated,
    posterFileId: drama.posterFileId,
    targetPlayableAssetId: pointer?.targetPlayableAssetId ?? null,
    currentPlayableAssetId: pointer?.currentPlayableAssetId ?? null,
  };
}

/** Caller has already locked all involved playable rows before touching this pointer. */
export async function setTrailerTarget(
  tx: Tx,
  input: {
    dramaId: string;
    playableAssetId: string;
    staffId: string;
    now: Date;
  },
) {
  const [drama, asset] = await Promise.all([
    readTrailerMediaFacts(tx, input.dramaId),
    tx.playableAsset.findUnique({
      where: { id: input.playableAssetId },
      select: { ownerType: true, ownerId: true, kind: true, state: true },
    }),
  ]);
  if (
    !drama ||
    !asset ||
    asset.ownerType !== "drama" ||
    asset.ownerId !== input.dramaId ||
    asset.kind !== "trailer" ||
    !["processing", "ready"].includes(asset.state)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  await tx.dramaTrailer.upsert({
    where: { dramaId: input.dramaId },
    create: {
      dramaId: input.dramaId,
      targetPlayableAssetId: input.playableAssetId,
      setByStaffId: input.staffId,
      setAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    },
    update: {
      targetPlayableAssetId: input.playableAssetId,
      setByStaffId: input.staffId,
      setAt: input.now,
      updatedAt: input.now,
    },
  });
}

/** A late result cannot replace the current trailer after the target changed. */
export async function installTrailerCurrent(
  tx: Tx,
  input: {
    dramaId: string;
    playableAssetId: string;
    now: Date;
  },
) {
  const facts = await readTrailerMediaFacts(tx, input.dramaId);
  if (!facts || facts.targetPlayableAssetId !== input.playableAssetId)
    return { changed: false, oldCurrentPlayableAssetId: null };
  const result = await tx.dramaTrailer.updateMany({
    where: {
      dramaId: input.dramaId,
      targetPlayableAssetId: input.playableAssetId,
      currentPlayableAssetId: facts.currentPlayableAssetId,
    },
    data: { currentPlayableAssetId: input.playableAssetId, updatedAt: input.now },
  });
  return {
    changed: result.count === 1,
    oldCurrentPlayableAssetId: result.count === 1 ? facts.currentPlayableAssetId : null,
  };
}
