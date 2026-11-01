import { z } from "zod";
import type { Tx } from "../kernel/index.js";
import { RenditionSchema } from "./playable-schemas.js";

/** Media-owned projection only; callers must authorize each polymorphic business owner. */
export async function readMerchantPlayableAsset(tx: Tx, playableId: string) {
  const asset = await tx.playableAsset.findUnique({
    where: { id: playableId },
    select: {
      id: true,
      kind: true,
      entityId: true,
      storeId: true,
      ownerType: true,
      ownerId: true,
      sourceFileId: true,
      state: true,
      durationMs: true,
      width: true,
      height: true,
      renditions: true,
      coverFileId: true,
      watermark: true,
      specVersion: true,
      readyAt: true,
      retiredAt: true,
      updatedAt: true,
      sourceFile: {
        select: {
          mediaInfo: {
            select: {
              coverFileId: true,
              durationMs: true,
              displayWidth: true,
              displayHeight: true,
            },
          },
        },
      },
    },
  });
  if (!asset) return null;
  const parsed = z.array(RenditionSchema).nonempty().safeParse(asset.renditions);
  const renditions = parsed.success ? parsed.data : null;
  const posterFileId = asset.coverFileId ?? asset.sourceFile.mediaInfo?.coverFileId ?? null;
  const ids = [
    ...new Set([
      asset.sourceFileId,
      ...(renditions?.map((row) => row.fileId) ?? []),
      ...(posterFileId ? [posterFileId] : []),
    ]),
  ];
  const refs = await tx.fileRef.findMany({
    where: {
      state: "live",
      OR: [
        { refType: "playable_asset", refId: asset.id },
        ...(asset.coverFileId === null && posterFileId
          ? [
              {
                refType: "media_info",
                refId: asset.sourceFileId,
                role: "cover",
                fileId: posterFileId,
              },
            ]
          : []),
      ],
    },
    select: { fileId: true, refType: true, refId: true, role: true },
    orderBy: [{ fileId: "asc" }, { refType: "asc" }, { refId: "asc" }, { role: "asc" }],
  });
  const files = await tx.fileObject.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      category: true,
      scopeType: true,
      entityId: true,
      storeId: true,
      status: true,
      moderationState: true,
      bucket: true,
      objectKey: true,
      ext: true,
      etag: true,
      sha256: true,
      sizeBytes: true,
      deletedAt: true,
      erasedAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  return { asset, renditions, posterFileId, refs, files };
}
export type MerchantPlayableAsset = NonNullable<
  Awaited<ReturnType<typeof readMerchantPlayableAsset>>
>;
