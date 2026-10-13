import type {
  StoreProfileBasicPatch,
  StoreProfileMediaPatch,
  StoreProfileServicePatch,
} from "@liyoxi/contract";
import type { FileObject } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { ProfileDeps } from "./context.js";
import type { ProfileSnapshot } from "./repo.js";
import { invalid, lockFiles, newCode } from "./validate.js";
export interface ProfileEditScope {
  readonly ctx: IdentityContext;
  readonly entityId: string;
  readonly storeId: string;
  readonly checkFile: (tx: Tx, id: string, categories: readonly string[]) => Promise<FileObject>;
}
/** 同一免审应用段；鉴权、版本、锁和审计由真实商家/员工入口负责。 */
export async function applyLogo(
  tx: Tx,
  deps: ProfileDeps,
  scope: ProfileEditScope,
  previousLogo: string | null,
  input: Pick<StoreProfileBasicPatch, "logoFileId">,
  now: Date,
) {
  if (input.logoFileId !== undefined && input.logoFileId !== previousLogo) {
    if (input.logoFileId) {
      await scope.checkFile(tx, input.logoFileId, ["profile_image"]);
      await deps.media.link(tx, {
        fileId: input.logoFileId,
        refType: "store_profile",
        refId: scope.storeId,
        role: "logo",
        entityId: scope.entityId,
        storeId: scope.storeId,
      });
    }
    if (previousLogo)
      await deps.media.release(tx, {
        fileId: previousLogo,
        refType: "store_profile",
        refId: scope.storeId,
        role: "logo",
        entityId: scope.entityId,
        storeId: scope.storeId,
        keepUntil: new Date(now.getTime() + 30 * 86_400_000),
      });
  }
}
export async function applyMedia(
  tx: Tx,
  deps: ProfileDeps,
  scope: ProfileEditScope,
  before: ProfileSnapshot,
  groups: StoreProfileMediaPatch["groups"],
  now: Date,
) {
  await lockFiles(tx, [
    ...before.media.map((row) => row.fileId),
    ...Object.values(groups).flatMap((items) => items.map((item) => item.fileId)),
  ]);
  for (const [group, items] of Object.entries(groups)) {
    if (new Set(items.map((item) => item.fileId)).size !== items.length)
      throw invalid("同组文件不能重复");
    const old = before.media.filter((row) => row.mediaGroup === group);
    const kinds = [];
    for (const item of items) {
      const kept = old.find((row) => row.fileId === item.fileId);
      const file = kept
        ? before.files.get(item.fileId)!
        : await scope.checkFile(
            tx,
            item.fileId,
            group === "promo"
              ? ["profile_promo"]
              : group === "product"
                ? ["profile_image", "profile_video"]
                : ["profile_image"],
          );
      const kind = (file.mime ?? "").startsWith("image/")
        ? "image"
        : (file.mime ?? "").startsWith("video/")
          ? "video"
          : "other";
      if (kind === "other" || ((group === "door" || group === "interior") && kind !== "image"))
        throw invalid("媒体组类型不符");
      if (kind === "video") {
        const info = await tx.mediaInfo.findUnique({ where: { fileId: item.fileId } });
        if (group === "product" && info?.durationMs != null && info.durationMs > 60_000)
          throw invalid("实拍视频不得超过 60 秒");
      }
      kinds.push(kind);
    }
    if (
      (group === "door" && items.length > 3) ||
      (group === "interior" && items.length > 9) ||
      (group === "promo" && items.length > 9) ||
      (group === "product" &&
        (kinds.filter((k) => k === "image").length > 9 ||
          kinds.filter((k) => k === "video").length > 3))
    )
      throw invalid("媒体组数量超限");
    // 临时挪开位置，免得同组的交换顺序撞在用位置唯一索引。
    await tx.storeProfileMedia.updateMany({
      where: { storeId: scope.storeId, mediaGroup: group, removedAt: null },
      data: { position: { increment: 100 } },
    });
    for (const removed of old.filter((row) => !items.some((item) => item.fileId === row.fileId))) {
      await tx.storeProfileMedia.update({
        where: { id: removed.id },
        data: { removedAt: now, updatedAt: now },
      });
      await deps.media.release(tx, {
        fileId: removed.fileId,
        refType: "store_profile_media",
        refId: removed.id,
        role: "main",
        entityId: scope.entityId,
        storeId: scope.storeId,
        keepUntil: new Date(now.getTime() + 30 * 86_400_000),
      });
    }
    for (const [i, item] of items.entries()) {
      const kept = old.find((row) => row.fileId === item.fileId);
      if (kept)
        await tx.storeProfileMedia.update({
          where: { id: kept.id },
          data: { position: i + 1, updatedAt: now },
        });
      else {
        const id = uuidv7();
        await tx.storeProfileMedia.create({
          data: {
            id,
            entityId: scope.entityId,
            storeId: scope.storeId,
            mediaGroup: group,
            position: i + 1,
            fileId: item.fileId,
            mediaKind: kinds[i]!,
            createActorType: scope.ctx.actor.type,
            createActorId: scope.ctx.actor.id,
            createClient: scope.ctx.actor.client,
            createdAt: now,
            updatedAt: now,
          },
        });
        await deps.media.link(tx, {
          fileId: item.fileId,
          refType: "store_profile_media",
          refId: id,
          role: "main",
          entityId: scope.entityId,
          storeId: scope.storeId,
        });
      }
    }
  }
}
export async function applyServices(
  tx: Tx,
  deps: ProfileDeps,
  scope: ProfileEditScope,
  before: ProfileSnapshot,
  input: Pick<StoreProfileServicePatch, "sellingPointCodes" | "serviceItems">,
  now: Date,
) {
  for (const code of input.sellingPointCodes ?? [])
    await newCode(
      tx,
      "store_selling_point",
      code,
      before.profile!.sellingPointCodes.includes(code) ? code : null,
      "sellingPointCodes",
    );
  if (input.serviceItems !== undefined) {
    const items = input.serviceItems,
      old = before.services;
    const ids = items.flatMap((item) => (item.serviceItemId ? [item.serviceItemId] : []));
    if (new Set(ids).size !== ids.length || ids.some((id) => !old.some((row) => row.id === id)))
      throw invalid("服务行不是本门店在用项，或重复");
    await lockFiles(tx, [
      ...old.map((row) => row.imageFileId),
      ...items.map((item) => item.imageFileId),
    ]);
    await tx.storeServiceItem.updateMany({
      where: { storeId: scope.storeId, removedAt: null },
      data: { position: { increment: 100 } },
    });
    for (const row of old.filter((row) => !ids.includes(row.id))) {
      await tx.storeServiceItem.update({
        where: { id: row.id },
        data: { removedAt: now, updatedAt: now },
      });
      if (row.imageFileId)
        await deps.media.release(tx, {
          fileId: row.imageFileId,
          refType: "store_service_item",
          refId: row.id,
          role: "image",
          entityId: scope.entityId,
          storeId: scope.storeId,
          keepUntil: new Date(now.getTime() + 30 * 86_400_000),
        });
    }
    for (const [i, item] of items.entries()) {
      const row = old.find((row) => row.id === item.serviceItemId),
        id = row?.id ?? uuidv7();
      const imageFileId =
        item.imageFileId === undefined ? (row?.imageFileId ?? null) : item.imageFileId;
      if (imageFileId && imageFileId !== row?.imageFileId) {
        await scope.checkFile(tx, imageFileId, ["profile_image"]);
        await deps.media.link(tx, {
          fileId: imageFileId,
          refType: "store_service_item",
          refId: id,
          role: "image",
          entityId: scope.entityId,
          storeId: scope.storeId,
        });
      }
      if (row?.imageFileId && row.imageFileId !== imageFileId)
        await deps.media.release(tx, {
          fileId: row.imageFileId,
          refType: "store_service_item",
          refId: id,
          role: "image",
          entityId: scope.entityId,
          storeId: scope.storeId,
          keepUntil: new Date(now.getTime() + 30 * 86_400_000),
        });
      const previousOriginal =
        item.originalPriceFen === undefined
          ? (row?.originalPriceFen ?? null)
          : item.originalPriceFen;
      if (previousOriginal !== null && previousOriginal < item.priceFen)
        throw invalid("原价不得低于现价");
      const data = {
        name: item.name,
        priceFen: item.priceFen,
        originalPriceFen:
          item.originalPriceFen === undefined
            ? (row?.originalPriceFen ?? null)
            : item.originalPriceFen,
        imageFileId,
        intro: item.intro === undefined ? (row?.intro ?? null) : item.intro,
        position: i + 1,
        updatedAt: now,
      };
      if (row) await tx.storeServiceItem.update({ where: { id }, data });
      else
        await tx.storeServiceItem.create({
          data: { ...data, id, entityId: scope.entityId, storeId: scope.storeId, createdAt: now },
        });
    }
  }
}
