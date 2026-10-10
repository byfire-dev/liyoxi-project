import type { StoreAsset } from "@liyoxi/db";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { byStore, assertCapability, assertPermission, satisfiesLevel } from "../../authz/index.js";
import type { MediaActor } from "../context.js";
import type { AssetDeps } from "./context.js";

export function assetActor(
  actor: MediaActor,
  action: "read" | "upload" | "review" | "demand" | "feedback",
  now: Date,
) {
  if (actor.staff) {
    if (!satisfiesLevel(actor.staff.moduleLevels.merchant, "view"))
      throw new AppError("ROLE_FORBIDDEN");
    const permissions = {
      upload: "merchant.asset.upload_on_behalf",
      review: "merchant.asset.review",
      demand: "merchant.asset.demand.create",
    } as const;
    const permission = permissions[action as keyof typeof permissions];
    if (permission) assertPermission(actor.staff, permission, now);
    return;
  }
  if (!actor.merchant || actor.identity.actor.type !== "merchant")
    throw new AppError("NOT_A_MEMBER");
  assertCapability(
    actor.merchant.standing,
    action === "feedback"
      ? "asset.feedback"
      : action === "upload"
        ? "asset.upload"
        : action === "demand"
          ? "asset.demand.read"
          : "asset.read",
  );
  if (action === "review") throw new AppError("ROLE_FORBIDDEN");
}
export function assetScope(actor: MediaActor) {
  return actor.staff
    ? byStore(actor.staff.scope)
    : {
        entityId: actor.merchant?.entityId ?? "00000000-0000-0000-0000-000000000000",
        storeId: actor.merchant?.storeId ?? "00000000-0000-0000-0000-000000000000",
      };
}
export async function assetOf(
  tx: Tx,
  actor: MediaActor,
  id: string,
  lock = false,
): Promise<StoreAsset> {
  const found = await tx.storeAsset.findFirst({
    where: { id, deletedAt: null, ...assetScope(actor) },
  });
  if (!found) throw new AppError("NOT_FOUND");
  if (lock) {
    await lockRows(tx, "store_asset", [id]);
    const current = await tx.storeAsset.findFirst({
      where: { id, deletedAt: null, ...assetScope(actor) },
    });
    if (!current) throw new AppError("NOT_FOUND");
    return current;
  }
  return found;
}
export async function assetStore(
  tx: Tx,
  deps: AssetDeps,
  actor: MediaActor,
  storeId: string,
  write = false,
) {
  const store = await deps.assets.readStore(tx, storeId, actor.staff?.scope);
  if (
    !store ||
    (actor.merchant &&
      (store.id !== actor.merchant.storeId || store.entityId !== actor.merchant.entityId))
  )
    throw new AppError("NOT_FOUND");
  if (write && store.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
  if (
    write &&
    actor.identity.actor.type === "merchant" &&
    actor.identity.actor.role === "clerk" &&
    !store.isPrimary &&
    store.qualificationStatus !== "verified"
  )
    throw new AppError("ASSET_UPLOAD_GATED");
  return store;
}
export async function assetFiles(tx: Tx, id: string) {
  return tx.storeAssetFile.findMany({
    where: { storeAssetId: id },
    orderBy: { position: "asc" },
    include: { file: { include: { mediaInfo: true } } },
  });
}
export async function lockAssetFiles(tx: Tx, ids: readonly string[]) {
  await lockRows(tx, "file_object", [...new Set(ids)].sort());
}
export async function assetDict(tx: Tx, codes: readonly string[], dimension: string) {
  const rows = await tx.dictItem.findMany({
    where: { dictTypeKey: "asset_tag", code: { in: [...codes] } },
  });
  for (const code of codes) {
    const row = rows.find((item) => item.code === code);
    const ext = row?.ext as { dimension?: string } | null;
    if (!row || ext?.dimension !== dimension) throw new AppError("VALIDATION_FAILED");
    if (!row.isEnabled) throw new AppError("DICT_ITEM_DISABLED");
  }
  return rows;
}
export async function rebuildAssetSearch(
  tx: Tx,
  deps: AssetDeps,
  asset: StoreAsset,
): Promise<void> {
  const uploader = await deps.assets.readUploader(tx, {
    entityId: asset.entityId,
    actorType: asset.uploadActorType,
    actorId: asset.uploadActorId,
  });
  const tags = await tx.storeAssetTag.findMany({ where: { storeAssetId: asset.id } });
  const dicts = await tx.dictItem.findMany({
    where: { dictTypeKey: "asset_tag", code: { in: tags.map((tag) => tag.tagCode) } },
  });
  const insights = await tx.storeAssetInsight.findMany({
    where: {
      storeAssetId: asset.id,
      status: "ok",
      kind: { in: ["transcript", "doc_text", "digest"] },
    },
    orderBy: { promptVersion: "desc" },
  });
  const texts = insights.map((insight) => {
    const content = insight.content as { text?: string; keypoints?: string[] };
    return [content.text?.slice(0, 8000), ...(content.keypoints ?? [])].filter(Boolean).join(" ");
  });
  await tx.storeAsset.update({
    where: { id: asset.id },
    data: {
      searchText: [
        asset.title,
        asset.textBody,
        asset.note,
        uploader.displayName,
        ...dicts.map((row) => row.name),
        ...texts,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 32000),
    },
  });
}
