import type { Tx } from "../kernel/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import type { AdOrderFact, AdSlot, AdStatus } from "./context.js";

export async function readAdOrderFacts(
  tx: Tx,
  input: { entityId: string; storeId: string } & (
    { adIds: readonly string[] } | { cursor?: string; limit: number }
  ),
): Promise<{ rows: AdOrderFact[]; nextCursor: string | null }> {
  const paged = !("adIds" in input);
  if (paged && (!Number.isSafeInteger(input.limit) || input.limit < 1))
    throw new TypeError("广告候选页容量必须是正整数");
  const ads = await tx.ad.findMany({
    where: {
      entityId: input.entityId,
      storeId: input.storeId,
      ...("adIds" in input
        ? { id: { in: [...input.adIds] } }
        : input.cursor
          ? { id: { gt: input.cursor } }
          : {}),
    },
    orderBy: { id: "asc" },
    ...("adIds" in input ? {} : { take: input.limit + 1 }),
  });
  const page = "adIds" in input ? ads : ads.slice(0, input.limit);
  const versions = await tx.adVersion.findMany({
    where: {
      OR: page.flatMap((ad) =>
        ad.confirmedVersionNo === null
          ? []
          : [
              {
                adId: ad.id,
                versionNo: ad.confirmedVersionNo,
                entityId: ad.entityId,
                storeId: ad.storeId,
                decision: "confirmed",
                pushedAt: { not: null },
              },
            ],
      ),
    },
    select: { adId: true, versionNo: true, fileId: true },
  });
  const files = await readMaterialFileFacts(
    tx,
    versions.map((version) => version.fileId),
  );
  return {
    rows: page.map((ad) => {
      const version = versions.find(
          (v) => v.adId === ad.id && v.versionNo === ad.confirmedVersionNo,
        ),
        file = version ? files.find((value) => value.id === version.fileId) : undefined;
      return {
        adId: ad.id,
        adNo: ad.adNo,
        entityId: ad.entityId,
        storeId: ad.storeId,
        type: ad.type as AdSlot,
        durationSec: ad.durationSec,
        copy: ad.copy,
        status: ad.status as AdStatus,
        confirmedAt: ad.confirmedAt?.toISOString() ?? null,
        confirmedVersionNo: ad.confirmedVersionNo,
        openCancelRequestId: ad.openCancelRequestId,
        confirmedVersion: version
          ? {
              versionNo: version.versionNo,
              fileId: version.fileId,
              mediaReady:
                !!file &&
                file.category === "ad_video" &&
                file.scopeType === "store" &&
                file.entityId === ad.entityId &&
                file.storeId === ad.storeId &&
                file.status === "stored" &&
                file.moderationState !== "block" &&
                file.deletedAt === null &&
                file.erasedAt === null &&
                file.productionRecord?.pipelineState === "ready" &&
                !!file.sha256 &&
                /^[a-f0-9]{64}$/.test(file.sha256) &&
                file.sizeBytes !== null &&
                file.sizeBytes > 0n,
            }
          : null,
      };
    }),
    nextCursor: "adIds" in input || ads.length <= input.limit ? null : page.at(-1)!.id,
  };
}

export async function readAdReopenFacts(
  tx: Tx,
  input: { entityId: string; storeId: string; adId: string },
) {
  const ad = await tx.ad.findFirst({
    where: { id: input.adId, entityId: input.entityId, storeId: input.storeId },
    select: {
      id: true,
      status: true,
      latestVersionNo: true,
      confirmedVersionNo: true,
      revisionCount: true,
      freeRevisionQuota: true,
      openCancelRequestId: true,
    },
  });
  if (!ad) return null;
  const latestPushedVersion = await tx.adVersion.findFirst({
    where: { adId: ad.id, pushedAt: { not: null } },
    orderBy: { versionNo: "desc" },
    select: { versionNo: true, fileId: true },
  });
  return { ...ad, adId: ad.id, latestPushedVersion };
}
