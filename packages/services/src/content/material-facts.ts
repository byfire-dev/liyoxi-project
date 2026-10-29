import type { Tx } from "../kernel/index.js";
import { readCommittedDramaMasters } from "../media/index.js";

/** Content owns the current master selection; media verifies its committed evidence. */
export async function readMaterialMasters(
  tx: Tx,
  input: { dramaId: string; episodeCount: number },
) {
  const candidates = await tx.dramaEpisodeMaster.findMany({
    where: {
      dramaId: input.dramaId,
      isCurrent: true,
      state: "ready",
      episodeNo: { gte: 1, lte: input.episodeCount },
      uploadBatchId: { not: null },
    },
    select: { uploadBatchId: true, episodeNo: true },
  });
  const groups = new Map<string, number[]>();
  for (const row of candidates) {
    const episodes = groups.get(row.uploadBatchId!) ?? [];
    episodes.push(row.episodeNo);
    groups.set(row.uploadBatchId!, episodes);
  }
  const masters = [];
  for (const [uploadBatchId, episodeNos] of groups) {
    const facts = await readCommittedDramaMasters(tx, {
      dramaId: input.dramaId,
      uploadBatchId,
      episodeNos,
    });
    for (const row of facts?.masters ?? [])
      masters.push({
        id: row.id,
        episodeNo: row.episodeNo,
        revNo: row.revNo,
        fileId: row.fileId,
        durationMs: row.durationMs,
      });
  }
  return masters.sort((a, b) => a.episodeNo - b.episodeNo);
}

export function readProductionMasterVersion(tx: Tx, id: string) {
  return tx.dramaEpisodeMaster.findUnique({ where: { id }, select: { id: true, revNo: true } });
}
