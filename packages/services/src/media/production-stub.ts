// 旧私有测试入口只委托真实制作准备；登记事实与媒体引用保持原公共契约。
import type { Tx } from "../kernel/index.js";
import type { Media } from "./runtime.js";
import type { ManualProductionInput } from "./production/prepare.js";
export { declareManualProduction } from "./production/prepare.js";
export type { ManualProductionInput } from "./production/prepare.js";

export async function ensureProductionStubs(
  tx: Tx,
  deps: { media: Pick<Media, "prepareDeliveryProduction"> },
  inputs: readonly ManualProductionInput[],
  beforeFiles?: () => Promise<void>,
) {
  return deps.media.prepareDeliveryProduction(tx, inputs, beforeFiles);
}

export const mediaDeliveryRefTypes = {
  upload_batch: {
    inUse: async (tx: Tx, fileId: string) =>
      (
        await tx.uploadBatchItem.findMany({
          where: {
            fileId,
            state: { notIn: ["skipped", "replaced"] },
            uploadBatch: { state: { notIn: ["committed", "canceled", "expired"] } },
          },
          select: { uploadBatchId: true },
        })
      ).map((row) => ({ fileId, refId: row.uploadBatchId, role: "main" })),
    roles: { main: { categories: ["final_episode", "drama_master"] as const, retentionDays: 0 } },
    readColumns: async (tx: Tx) =>
      (
        await tx.uploadBatchItem.findMany({
          where: {
            file: { status: "stored" },
            state: { notIn: ["skipped", "replaced"] },
          },
        })
      ).map((i) => ({ fileId: i.fileId, refId: i.uploadBatchId, role: "main" })),
  },
  playable_asset: {
    inUse: async (tx: Tx, fileId: string) =>
      (
        await tx.playableAsset.findMany({
          where: {
            state: { not: "retired" },
            retiredAt: null,
            OR: [
              { sourceFileId: fileId },
              { coverFileId: fileId },
              { renditions: { array_contains: [{ fileId }] } },
            ],
          },
          select: { id: true, sourceFileId: true, coverFileId: true, renditions: true },
        })
      ).flatMap((row) => [
        ...(row.sourceFileId === fileId ? [{ fileId, refId: row.id, role: "source" }] : []),
        ...(row.coverFileId === fileId ? [{ fileId, refId: row.id, role: "cover" }] : []),
        ...((row.renditions ?? []) as Array<{ fileId: string }>)
          .filter((item) => item.fileId === fileId)
          .map(() => ({ fileId, refId: row.id, role: "rendition" })),
      ]),
    roles: {
      source: {
        categories: ["sample_video", "ad_video", "trailer_src"] as const,
        retentionDays: 30,
      },
      rendition: {
        categories: ["sample_video", "sample_wm", "ad_video", "trailer_out"] as const,
        retentionDays: 30,
      },
      cover: { categories: ["video_cover", "poster"] as const, retentionDays: 30 },
    },
    readColumns: async (tx: Tx) =>
      (await tx.playableAsset.findMany()).flatMap((p) => [
        { fileId: p.sourceFileId, refId: p.id, role: "source" },
        ...((p.renditions ?? []) as Array<{ fileId: string }>).map((r) => ({
          fileId: r.fileId,
          refId: p.id,
          role: "rendition",
        })),
        ...(p.coverFileId ? [{ fileId: p.coverFileId, refId: p.id, role: "cover" }] : []),
      ]),
  },
};
