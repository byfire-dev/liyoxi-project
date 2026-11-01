import type { AdVersionCreateBody, AdVersionPushBody } from "@liyoxi/contract";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { readMaterialFileFacts, recordAdVersionAdoptedAssets } from "../media/index.js";
import type { AdStaffActor } from "./context.js";
import { assertAdStaff } from "./admin-read.js";
import type { AdAdminReadDeps } from "./admin-read.js";
import { prelockAdminAdTx } from "./admin-write.js";
import { registerAdVersionTx, pushAdVersionTx } from "./production-write.js";

export async function registerAdminAdVersionTx(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  adId: string,
  body: AdVersionCreateBody,
) {
  assertAdStaff(actor, "delivery.ad.upload", true);
  const ad = await prelockAdminAdTx(tx, actor, adId);
  if (ad.editorId !== actor.staff.staff.id) throw new AppError("PERMISSION_DENIED");
  const assets = body.adoptedStoreAssetIds ?? [];
  await lockRows(tx, "store_asset", assets);
  await lockRows(tx, "file_object", [body.fileId]);
  const file = (await readMaterialFileFacts(tx, [body.fileId]))[0];
  const info = file?.mediaInfo;
  if (!info?.durationMs || !info.displayWidth || !info.displayHeight)
    throw new AppError("PRODUCTION_NOT_READY");
  const created = await registerAdVersionTx(tx, deps, actor, adId, {
    fileId: body.fileId,
    durationMs: info.durationMs,
    width: info.displayWidth,
    height: info.displayHeight,
    segments: body.segments ?? [],
  });
  await recordAdVersionAdoptedAssets(tx, deps, actor.ctx, {
    entityId: ad.entityId,
    storeId: ad.storeId,
    adVersionId: created.adVersionId,
    storeAssetIds: assets,
  });
  return created;
}
export async function pushAdminAdVersionTx(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  adVersionId: string,
  body: AdVersionPushBody,
) {
  assertAdStaff(actor, "delivery.ad.upload", true);
  const version = await tx.adVersion.findUnique({
    where: { id: adVersionId },
    select: { adId: true },
  });
  if (!version) throw new AppError("NOT_FOUND");
  await prelockAdminAdTx(tx, actor, version.adId);
  return pushAdVersionTx(tx, deps, actor, adVersionId, body);
}
