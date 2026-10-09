import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** The caller supplies its transaction; media never reads L2 drama tables directly. */
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
  return { ...drama, episodes };
}
export type UploadDramaFacts = Awaited<ReturnType<typeof readUploadDramaFacts>>;
