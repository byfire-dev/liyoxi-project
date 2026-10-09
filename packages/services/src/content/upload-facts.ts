import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** Same-transaction facts through the composition; media never reads content-owned tables. */
export async function readUploadDramaFacts(tx: Tx, dramaId: string) {
  const drama = await tx.drama.findUnique({
    where: { id: dramaId },
    select: { id: true, title: true, totalEpisodes: true, isAiGenerated: true, archivedAt: true },
  });
  if (!drama) throw new AppError("NOT_FOUND");
  const episodes = await tx.dramaEpisode.findMany({
    where: { dramaId },
    select: { episodeNo: true, title: true },
    orderBy: { episodeNo: "asc" },
  });
  const masters = await tx.dramaEpisodeMaster.findMany({
    where: { dramaId, isCurrent: true },
    select: { id: true, episodeNo: true, durationMs: true, fileId: true },
    orderBy: { episodeNo: "asc" },
  });
  return { ...drama, episodes, masters };
}
export type UploadDramaFacts = Awaited<ReturnType<typeof readUploadDramaFacts>>;
