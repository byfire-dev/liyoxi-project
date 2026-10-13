import { lockRows } from "../../kernel/index.js";
import { release } from "../refs.js";
import type { SweepContext } from "./sweep-context.js";
import { SWEEP_BATCH } from "./sweep-context.js";

export async function releaseArchivedAssets(ctx: SweepContext, after?: string) {
  if (!ctx.deps.assets) throw new TypeError("归档素材释放需要真实门店公口");
  const readStore = ctx.deps.assets.readStore;
  return ctx.transaction("archived-assets", async (tx) => {
    const refs = await tx.fileRef.findMany({
      where: {
        refType: "store_asset",
        state: "live",
        role: { in: ["main", "portrait_auth"] },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
    });
    const assets = await tx.storeAsset.findMany({
      where: { id: { in: refs.map((ref) => ref.refId) } },
      orderBy: { id: "asc" },
      select: { id: true, storeId: true },
    });
    await lockRows(tx, "store", [...new Set(assets.map((asset) => asset.storeId))].sort());
    const stores = new Map<string, Awaited<ReturnType<typeof readStore>>>();
    for (const id of [...new Set(assets.map((asset) => asset.storeId))])
      stores.set(id, await readStore(tx, id));
    await lockRows(
      tx,
      "store_asset",
      assets.map((asset) => asset.id),
    );
    const eligible = refs.filter((ref) => {
      const asset = assets.find((asset) => asset.id === ref.refId),
        store = asset ? stores.get(asset.storeId) : undefined;
      if (store?.lifecycle === "archived" && !store.archivedAt)
        throw new TypeError("归档事实缺少真实archivedAt");
      return store?.lifecycle === "archived" && store.archivedAt;
    });
    await lockRows(tx, "file_object", [...new Set(eligible.map((ref) => ref.fileId))].sort());
    for (const ref of eligible) {
      const asset = await tx.storeAsset.findUniqueOrThrow({ where: { id: ref.refId } });
      const store = stores.get(asset.storeId);
      if (!store?.archivedAt || store.entityId !== asset.entityId)
        throw new TypeError("素材归属与门店事实不符");
      const keepUntil = new Date(store.archivedAt.getTime());
      if (ref.role === "portrait_auth") {
        const month = keepUntil.getUTCMonth();
        keepUntil.setUTCFullYear(keepUntil.getUTCFullYear() + 3);
        if (keepUntil.getUTCMonth() !== month) keepUntil.setUTCDate(0);
      } else keepUntil.setTime(keepUntil.getTime() + 180 * 86_400_000);
      await release(ctx.deps, tx, {
        fileId: ref.fileId,
        refType: ref.refType,
        refId: ref.refId,
        role: ref.role,
        entityId: asset.entityId,
        storeId: asset.storeId,
        keepUntil,
      });
    }
    return {
      released: eligible.length,
      after: refs.length === SWEEP_BATCH ? refs.at(-1)!.id : undefined,
    };
  });
}
