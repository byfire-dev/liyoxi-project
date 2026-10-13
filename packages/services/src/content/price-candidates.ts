import type { HeatTier } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
/** 模板档实际影响候选；template/custom属于billing，由调用方核其当前价目。不改内容行。 */
export function readTemplatePriceCandidates(tx: Tx, tiers: readonly HeatTier[]) {
  return tx.drama.findMany({
    where: { heatTier: { in: [...tiers] } },
    select: { id: true, heatTier: true },
    orderBy: { id: "asc" },
  });
}
