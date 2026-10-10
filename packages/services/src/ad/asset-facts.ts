import type { Tx } from "../kernel/index.js";

export async function readAdAssetUsage(
  tx: Tx,
  input: { usedByType: string; usedById: string; entityId: string; storeId: string },
) {
  const scope = { entityId: input.entityId, storeId: input.storeId };
  if (input.usedByType === "ad") {
    const ad = await tx.ad.findFirst({
      where: { id: input.usedById, ...scope },
      select: { id: true, adNo: true },
    });
    return ad ? { type: "ad" as const, id: ad.id, no: ad.adNo } : null;
  }
  if (input.usedByType !== "ad_version") return null;
  const version = await tx.adVersion.findFirst({
    where: { id: input.usedById, ...scope },
    select: { ad: { select: { id: true, adNo: true } } },
  });
  return version ? { type: "ad" as const, id: version.ad.id, no: version.ad.adNo } : null;
}

export async function hasAssetEditingAd(tx: Tx, input: { storeId: string; staffId: string }) {
  return (
    (await tx.ad.count({
      where: {
        storeId: input.storeId,
        editorId: input.staffId,
        status: { notIn: ["confirmed", "cancelled"] },
      },
    })) > 0
  );
}
