import { AdminOrderDetailSchema } from "@liyoxi/contract";
import type { AdminOrderDetail } from "@liyoxi/contract";
import { UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import {
  readMaterialAssetFacts,
  readMaterialFileFacts,
  readOrderAssetReferences,
} from "../media/index.js";
import { readMaterialProfile } from "../profile/index.js";
import type { OrderDeps } from "./context.js";

type ReferenceFile = AdminOrderDetail["referenceFiles"][number];
type File = Awaited<ReturnType<typeof readMaterialFileFacts>>[number];
const images = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const stored = (file: File | undefined): file is File =>
  !!file &&
  file.status === "stored" &&
  file.moderationState !== "block" &&
  file.deletedAt === null &&
  file.erasedAt === null;

/** 完整集合取本单live引用；W5-04的readOrderReferenceFileIds仅为档案候选，不当全集。 */
export async function readOrderReferenceFiles(tx: Tx, scope: DataScope, id: string) {
  const order = await tx.dramaOrder.findFirst({
    where: { id, store: managedStore(scope) },
    select: {
      id: true,
      entityId: true,
      storeId: true,
      deliveryManagerId: true,
      store: { select: { deliveryManagerId: true } },
    },
  });
  if (!order) throw new AppError("NOT_FOUND");
  const refs = await tx.fileRef.findMany({
    where: { refType: "drama_order", refId: id, role: "reference", state: "live" },
    select: { id: true, fileId: true, updatedAt: true },
    orderBy: { fileId: "asc" },
  });
  const ids = refs.map((ref) => ref.fileId);
  const assets = await readMaterialAssetFacts(tx, {
    entityId: order.entityId,
    storeId: order.storeId,
    ids: await readOrderAssetReferences(tx, id),
  });
  const profile = await readMaterialProfile(tx, {
    entityId: order.entityId,
    storeId: order.storeId,
    fileIds: ids,
  });
  const files = await readMaterialFileFacts(tx, ids);
  const covers = await readMaterialFileFacts(
    tx,
    files.flatMap((file) => (file.mediaInfo?.coverFileId ? [file.mediaInfo.coverFileId] : [])),
  );
  const entries: Array<{ view: ReferenceFile; thumbnailId: string | null }> = [];
  for (const ref of refs) {
    const asset = assets.find((asset) =>
      asset.storeAssetFiles.some((file) => file.fileId === ref.fileId),
    );
    const media = profile.media.find((media) => media.fileId === ref.fileId);
    if (!asset && !media) continue; // 未知/错归属引用不能借profile分支获得读权限。
    const file = files.find((file) => file.id === ref.fileId);
    const categories = asset
      ? ["store_asset"]
      : ["profile_image", "profile_video", "profile_promo"];
    const owned =
      file &&
      file.entityId === order.entityId &&
      file.scopeType === "store" &&
      categories.includes(file.category) &&
      (file.storeId === order.storeId ||
        UPLOAD_CATEGORIES[file.category as keyof typeof UPLOAD_CATEGORIES]?.crossStore);
    let thumbnailId: string | null = null;
    if (owned && stored(file) && asset?.moderationState !== "block") {
      if (images.has(file.ext)) thumbnailId = file.id;
      else {
        const cover = covers.find((cover) => cover.id === file.mediaInfo?.coverFileId);
        if (
          stored(cover) &&
          cover.category === "video_cover" &&
          images.has(cover.ext) &&
          cover.scopeType === file.scopeType &&
          cover.entityId === file.entityId &&
          cover.storeId === file.storeId
        )
          thumbnailId = cover.id;
      }
    }
    entries.push({
      view: AdminOrderDetailSchema.shape.referenceFiles.element.parse({
        fileId: ref.fileId,
        source: asset ? "store_asset" : "profile_media",
        storeAssetId: asset?.id ?? null,
        title: asset?.title ?? null,
        usability: asset?.usability ?? null,
        mediaGroup: asset ? null : media!.mediaGroup,
        type: asset?.type ?? media!.mediaKind,
        thumbnail: null,
      }),
      thumbnailId,
    });
  }
  return { order, refs, assets, media: profile.media, files, covers, entries };
}

const fingerprint = (value: Awaited<ReturnType<typeof readOrderReferenceFiles>>) =>
  JSON.stringify(value, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

/** GET签名在事务外；前后重新执行本单范围、实际引用、来源与文件内容安全检查，不写业务行。 */
export async function signOrderReferenceFiles(
  deps: OrderDeps,
  scope: DataScope,
  view: AdminOrderDetail,
): Promise<AdminOrderDetail> {
  const initial = await deps.tx.run((tx) => readOrderReferenceFiles(tx, scope, view.orderId));
  if (
    JSON.stringify(view.referenceFiles) !==
    JSON.stringify(initial.entries.map((entry) => entry.view))
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  const signed = new Map<string, { url: string; expiresAt: string }>();
  for (const entry of initial.entries) {
    if (entry.thumbnailId && !signed.has(entry.thumbnailId))
      signed.set(
        entry.thumbnailId,
        await deps.media.signRead({ fileId: entry.thumbnailId, audience: "staff" }),
      );
  }
  const current = await deps.tx.run((tx) => readOrderReferenceFiles(tx, scope, view.orderId));
  if (
    fingerprint(initial) !== fingerprint(current) ||
    [...signed.values()].some((url) => new Date(url.expiresAt) <= deps.clock.now())
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  return {
    ...view,
    referenceFiles: initial.entries.map((entry) => ({
      ...entry.view,
      thumbnail: entry.thumbnailId ? (signed.get(entry.thumbnailId) ?? null) : null,
    })),
  };
}
