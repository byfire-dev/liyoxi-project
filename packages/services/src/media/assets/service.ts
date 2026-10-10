import { AppError } from "../../kernel/index.js";
import { StoreAssetCardSchema } from "@liyoxi/contract";
import type { BoundMediaDeps, MediaActor } from "../context.js";
import type { Tx } from "../../kernel/index.js";
import { createAssetWrites } from "./write.js";
import { createAssetReads } from "./read.js";
import { createAssetDemands } from "./demands.js";
import { assetScope } from "./repo.js";
import { assetView, attachAssetUrls } from "./views.js";
import { createSigner } from "../read.js";
export function createMediaAssets(deps: BoundMediaDeps) {
  if (!deps.assets) throw new AppError("PROVIDER_UNAVAILABLE");
  const bound = { ...deps, assets: deps.assets },
    signer = createSigner(bound);
  return {
    ...createAssetWrites(bound),
    ...createAssetReads(bound),
    demands: createAssetDemands(bound),
    async recent(tx: Tx, actor: MediaActor) {
      if (actor.staff || !actor.merchant) throw new AppError("ROLE_FORBIDDEN");
      const rows = await tx.storeAsset.findMany({
        where: { deletedAt: null, ...assetScope(actor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 3,
      });
      const cards = [];
      for (const row of rows)
        cards.push(StoreAssetCardSchema.parse(await assetView(tx, bound, actor, row, false)));
      return cards;
    },
    decorate: <T extends { storeAssetId: string; thumbnail: unknown }>(
      actor: MediaActor,
      card: T,
    ) => attachAssetUrls(bound, actor, card, async (input) => (await signer(input)).signed),
  };
}
export type MediaAssets = ReturnType<typeof createMediaAssets>;
