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
  const unusable = (reason: string) =>
    new AppError("FILE_NOT_USABLE", {
      details: { fileIds: [body.fileId], reason },
    });
  if (!file || file.status !== "stored") throw unusable("not_stored");
  if (file.category !== "ad_video") throw unusable("category_mismatch");
  if (file.moderationState === "block") throw unusable("blocked");
  if (
    file.scopeType !== "store" ||
    file.entityId !== ad.entityId ||
    file.storeId !== ad.storeId ||
    file.deletedAt ||
    file.erasedAt
  )
    throw unusable("context_mismatch");
  const production = await deps.media.adProductionFacts(tx, body.fileId);
  if (production.production?.kind !== "ad" || production.production.adId !== ad.id)
    throw unusable("context_mismatch");
  const info = file.mediaInfo;
  if (!info?.durationMs || !info.displayWidth || !info.displayHeight || !production.ready)
    throw new AppError("PRODUCTION_NOT_READY", {
      details: {
        fileId: body.fileId,
        pipelineState: production.production.pipelineState,
        gate: production.gate,
      },
    });
  const durationMs = info.durationMs;
  const invalidSegment = body.segments?.findIndex((segment) => segment.toMs > durationMs);
  if (invalidSegment !== undefined && invalidSegment >= 0)
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: [
          { path: `segments.${invalidSegment}.toMs`, message: "分段结束时间不能超过视频时长" },
        ],
      },
    });
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
  const ad = await prelockAdminAdTx(tx, actor, version.adId);
  try {
    return await pushAdVersionTx(tx, deps, actor, adVersionId, body);
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      !["AD_VERSION_SPEC_INVALID", "PRODUCTION_NOT_READY"].includes(error.error)
    )
      throw error;
    // The shared producer has already refused the push. Only its admin error projection changes.
    const current = await tx.adVersion.findUniqueOrThrow({ where: { id: adVersionId } });
    const file = (await readMaterialFileFacts(tx, [current.fileId]))[0];
    const production = await deps.media.adProductionFacts(tx, current.fileId);
    const info = file?.mediaInfo;
    const width = info?.displayWidth ?? current.width;
    const height = info?.displayHeight ?? current.height;
    const durationMs = info?.durationMs ?? current.durationMs;
    const checks: { code: string; actual: unknown; expected: unknown }[] = [];
    if (width * 16 !== height * 9)
      checks.push({ code: "aspect", actual: `${width}:${height}`, expected: "9:16" });
    if (width !== 1080 || height !== 1920 || current.width !== width || current.height !== height)
      checks.push({
        code: "resolution",
        actual: { width, height, versionWidth: current.width, versionHeight: current.height },
        expected: { width: 1080, height: 1920 },
      });
    if (
      Math.abs(durationMs - ad.durationSec * 1000) > 500 ||
      durationMs !== current.durationMs ||
      (production.durationMs !== null && production.durationMs !== current.durationMs)
    )
      checks.push({
        code: "duration",
        actual: { durationMs, versionDurationMs: current.durationMs },
        expected: { minMs: ad.durationSec * 1000 - 500, maxMs: ad.durationSec * 1000 + 500 },
      });
    if (!production.ready || production.production?.adId !== ad.id || checks.length === 0)
      checks.push({
        code: "file_not_ready",
        actual: {
          ready: production.ready,
          pipelineState: production.production?.pipelineState ?? null,
          gate: production.gate,
          playableReady: !!production.playable,
        },
        expected: {
          ready: true,
          pipelineState: "ready",
          ...(production.ready && !production.playable ? { playableReady: true } : {}),
        },
      });
    throw new AppError("AD_VERSION_SPEC_INVALID", { details: { checks } });
  }
}
