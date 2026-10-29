import { AppError, isUuid, lockRows } from "../kernel/index.js";
import type { RowLockMode, Tx } from "../kernel/index.js";
import type { Media } from "../media/index.js";

/** The delivery parent is already locked. Existing assets precede production and file locks. */
export async function productionEvidence(
  tx: Tx,
  media: Pick<Media, "deliveryProductionFacts">,
  fileId: string,
  watermarked = false,
  fileLockMode: RowLockMode = "share",
) {
  const before = watermarked
    ? await tx.playableAsset.findMany({
        where: { kind: "sample", sourceFileId: fileId },
      })
    : [];
  await lockRows(
    tx,
    "playable_asset",
    before.map((row) => row.id),
    "share",
  );
  await lockRows(tx, "production_record", [fileId], "share");
  const assets = watermarked
    ? await tx.playableAsset.findMany({
        where: { kind: "sample", sourceFileId: fileId },
      })
    : [];
  if (assets.some((row) => !before.some((old) => old.id === row.id))) throw new AppError("BUSY");
  const outputIds = assets.flatMap((asset) =>
    Array.isArray(asset.renditions)
      ? asset.renditions.flatMap((row) =>
          row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          typeof row.fileId === "string" &&
          isUuid(row.fileId)
            ? [row.fileId]
            : [],
        )
      : [],
  );
  // Reference writers need UPDATE from the first sorted file lock, before any later rendition id.
  await lockRows(tx, "file_object", [fileId, ...outputIds], fileLockMode);
  const facts = await media.deliveryProductionFacts(tx, fileId);
  if (!facts.ready || !facts.production || (watermarked && !facts.playable))
    throw watermarked
      ? new AppError("SAMPLE_PREVIEW_NOT_READY")
      : new AppError("PRODUCTION_NOT_READY", {
          details: {
            fileId,
            pipelineState: facts.production?.pipelineState ?? "missing",
            gate: facts.gate,
          },
        });
  return facts;
}
