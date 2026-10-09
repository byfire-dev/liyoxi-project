import type { Tx, InvariantScope, InvariantViolation } from "../../kernel/index.js";
import { objectContent } from "./views.js";

export async function findAssetViolations(
  tx: Tx,
  scope: InvariantScope,
  code: "I12" | "I16" | "I17",
): Promise<InvariantViolation[]> {
  const where = scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {};
  const rows = await tx.storeAsset.findMany({
    where,
    select: { id: true, entityId: true, usability: true, adoptedCount: true },
  });
  const violations: InvariantViolation[] = [];
  for (const asset of rows) {
    if (code === "I17") {
      const tags = await tx.storeAssetTag.findMany({ where: { storeAssetId: asset.id } });
      const dicts = await tx.dictItem.findMany({
        where: { dictTypeKey: "asset_tag", code: { in: tags.map((tag) => tag.tagCode) } },
      });
      for (const tag of tags) {
        const dict = dicts.find((dict) => dict.code === tag.tagCode);
        // Existence/type belongs to config.N7; this check owns dimension agreement only.
        if (dict && objectContent(dict.ext).dimension !== tag.dimension)
          violations.push({
            subject: { type: "store_asset_tag", id: tag.id },
            entityId: asset.entityId,
            detail: { problem: "标签与字典维度不一致" },
          });
      }
      continue;
    }
    const count = await tx.storeAssetUsage.count({
      where: { storeAssetId: asset.id, role: "adopted" },
    });
    if (
      (code === "I12" && asset.usability === "need_portrait_auth" && count > 0) ||
      (code === "I16" && count !== asset.adoptedCount)
    )
      violations.push({
        subject: { type: "store_asset", id: asset.id },
        entityId: asset.entityId,
        detail: {
          problem: code === "I12" ? "肖像未确认素材存在采用记录" : "采用计数与实际使用记录不一致",
        },
      });
  }
  return violations;
}
