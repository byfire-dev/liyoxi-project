import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface DramaReadinessInput {
  dramaId: string;
  totalEpisodes: number | null;
  posterFileId: string | null;
  episodeNos: readonly number[];
  documentFileIds?: readonly string[];
}
/** Content supplies its own facts; this reader only reads media-owned records. */
export async function dramaMediaReadiness(tx: Tx, input: DramaReadinessInput, at: Date) {
  const [poster, current, batches, pointer, documents] = await Promise.all([
    input.posterFileId ? tx.fileObject.findUnique({ where: { id: input.posterFileId } }) : null,
    tx.dramaEpisodeMaster.findMany({
      where: { dramaId: input.dramaId, isCurrent: true },
      include: { file: { include: { mediaChecks: true } } },
      orderBy: { episodeNo: "asc" },
    }),
    tx.uploadBatch.findMany({
      where: {
        purpose: "drama_master",
        targetId: input.dramaId,
        state: { in: ["matching", "uploading", "verifying", "ready"] },
        expiresAt: { gt: at },
      },
      include: { uploadBatchItems: { orderBy: { id: "asc" } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.dramaTrailer.findUnique({
      where: { dramaId: input.dramaId },
      include: {
        targetPlayableAsset: true,
        currentPlayableAsset: {
          include: {
            sourceFile: {
              select: { status: true, category: true, scopeType: true, moderationState: true },
            },
          },
        },
      },
    }),
    tx.fileObject.findMany({
      where: {
        id: { in: [...(input.documentFileIds ?? [])] },
        status: "stored",
        category: "drama_license_doc",
        scopeType: "platform",
        moderationState: { not: "block" },
      },
      select: { id: true },
    }),
  ]);
  const usable = current.filter(
    (master) =>
      master.state === "ready" &&
      master.durationMs !== null &&
      master.activatedAt !== null &&
      master.file.status === "stored" &&
      master.file.category === "drama_master" &&
      master.file.scopeType === "platform" &&
      master.file.moderationState !== "block" &&
      master.file.mediaChecks[0]?.profile === "master" &&
      master.file.mediaChecks[0]?.gate === "pass",
  );
  const byEpisode = new Map(usable.map((master) => [master.episodeNo, master]));
  const processing = new Map<number, string>();
  for (const batch of batches)
    for (const item of batch.uploadBatchItems)
      if (item.episodeNo !== null && !["skipped", "replaced", "rejected"].includes(item.state))
        processing.set(item.episodeNo, batch.id);
  const episodes = input.episodeNos.map((episodeNo) => ({
    episodeNo,
    currentMaster: byEpisode.get(episodeNo) ?? null,
    openUploadBatchId: processing.get(episodeNo) ?? null,
    masterState: processing.has(episodeNo)
      ? "processing"
      : byEpisode.has(episodeNo)
        ? "ready"
        : "missing",
  }));
  const missingEpisodeNos: number[] = [];
  for (let n = 1; n <= (input.totalEpisodes ?? 0); n++)
    if (!byEpisode.has(n) && missingEpisodeNos.length < 100) missingEpisodeNos.push(n);
  const target = pointer?.targetPlayableAsset;
  const currentTrailer = pointer?.currentPlayableAsset;
  const currentSource = currentTrailer?.sourceFile;
  const [sourceFile, sourceInfo] = await Promise.all([
    target ? tx.fileObject.findUnique({ where: { id: target.sourceFileId } }) : null,
    target ? tx.mediaInfo.findUnique({ where: { fileId: target.sourceFileId } }) : null,
  ]);
  if (target && !sourceFile) throw new AppError("NOT_FOUND");
  const withCurrentMaster = episodes.filter((episode) => episode.currentMaster !== null).length;
  return {
    poster,
    usableDocumentFileIds: documents.map((v) => v.id),
    episodes,
    allMasterFileIds: (
      await tx.dramaEpisodeMaster.findMany({
        where: { dramaId: input.dramaId },
        select: { fileId: true },
      })
    ).map((v) => v.fileId),
    allCurrentMasterEpisodeNos: current.map((v) => v.episodeNo),
    masters: { totalEpisodes: input.totalEpisodes, withCurrentMaster, missingEpisodeNos },
    mastersReady:
      input.totalEpisodes !== null &&
      input.episodeNos.length === input.totalEpisodes &&
      withCurrentMaster === input.totalEpisodes,
    isTrailerReady:
      currentTrailer?.state === "ready" &&
      currentTrailer.kind === "trailer" &&
      currentTrailer.durationMs !== null &&
      currentTrailer.durationMs <= 180000 &&
      currentTrailer.ownerType === "drama" &&
      currentTrailer.ownerId === input.dramaId &&
      currentSource?.status === "stored" &&
      currentSource.category === "trailer_src" &&
      currentSource.scopeType === "platform" &&
      currentSource.moderationState !== "block",
    trailer: pointer && target && sourceFile ? { pointer, target, sourceFile, sourceInfo } : null,
    openUploadBatches: batches,
  };
}
export type DramaMediaReadiness = Awaited<ReturnType<typeof dramaMediaReadiness>>;

export async function readCommittedDramaMasters(
  tx: Tx,
  input: {
    dramaId: string;
    uploadBatchId: string;
    episodeNos: readonly number[];
  },
) {
  const batch = await tx.uploadBatch.findUnique({ where: { id: input.uploadBatchId } });
  if (
    !batch ||
    batch.purpose !== "drama_master" ||
    batch.targetId !== input.dramaId ||
    batch.state !== "committed"
  )
    return null;
  const masters = await tx.dramaEpisodeMaster.findMany({
    where: {
      dramaId: input.dramaId,
      uploadBatchId: batch.id,
      episodeNo: { in: [...input.episodeNos] },
      isCurrent: true,
      state: "ready",
    },
    include: { file: { include: { mediaChecks: true } } },
    orderBy: { episodeNo: "asc" },
  });
  return {
    isContentChanged: batch.isContentChanged,
    masters: masters.filter(
      (v) =>
        v.file.status === "stored" &&
        v.file.category === "drama_master" &&
        v.file.scopeType === "platform" &&
        v.file.moderationState !== "block" &&
        v.file.mediaChecks[0]?.profile === "master" &&
        v.file.mediaChecks[0]?.gate === "pass",
    ),
  };
}

export async function readDramaPosterFileIds(tx: Tx, dramaId: string) {
  return (
    await tx.fileRef.findMany({
      where: { refType: "drama", refId: dramaId, role: "poster", state: "live" },
      select: { fileId: true },
    })
  ).map((v) => v.fileId);
}

/** Content supplies only its owned IDs; media supplies the live reference facts. */
export async function readDramaEvidenceRefs(
  tx: Tx,
  input: {
    dramaId: string;
    permitIds: readonly string[];
    copyrightRevisionIds: readonly string[];
  },
) {
  return tx.fileRef.findMany({
    where: {
      state: "live",
      OR: [
        { refType: "drama_permit", refId: { in: [...input.permitIds] }, role: "scan" },
        { refType: "drama_copyright", refId: input.dramaId, role: "proof" },
        {
          refType: "drama_copyright_revision",
          refId: { in: [...input.copyrightRevisionIds] },
          role: "proof",
        },
      ],
    },
    select: { fileId: true, refType: true, refId: true, role: true },
    orderBy: [{ fileId: "asc" }, { id: "asc" }],
  });
}
