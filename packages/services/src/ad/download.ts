import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { record } from "../audit/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";
import { member, merchantAd } from "./lifecycle.js";
import { readMaterialFileFacts } from "../media/index.js";
/** Read-only preparation. A failed storage signature never creates viewing evidence. */
export async function prepareAdDownload(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  adId: string,
  versionNo: number,
) {
  await member(tx, actor);
  const ad = await merchantAd(tx, actor, adId),
    v = await tx.adVersion.findFirst({
      where: { adId, pushedAt: { not: null } },
      orderBy: { versionNo: "desc" },
    });
  if (!v || v.versionNo !== versionNo)
    throw new AppError("AD_VERSION_STALE", { details: { currentVersionNo: v?.versionNo ?? null } });
  if (ad.status === "cancelled") throw new AppError("STATE_NOT_ALLOWED");
  const enabled = await deps.playback(ad.entityId),
    fallback =
      v.previewChannels.includes("weapp") &&
      !v.previewChannels.includes("album") &&
      !v.previewChannels.includes("portal") &&
      !enabled;
  if (!v.previewChannels.includes("album") && !fallback)
    throw new AppError("AD_PREVIEW_CHANNEL_UNAVAILABLE", {
      details: { previewChannels: v.previewChannels },
    });
  const f = (await readMaterialFileFacts(tx, [v.fileId]))[0];
  if (
    !f ||
    f.category !== "ad_video" ||
    f.scopeType !== "store" ||
    f.entityId !== ad.entityId ||
    f.storeId !== ad.storeId ||
    f.status !== "stored" ||
    f.moderationState === "block" ||
    f.deletedAt ||
    f.erasedAt ||
    f.sizeBytes === null ||
    !f.sha256 ||
    !f.etag
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  return {
    adId,
    versionNo,
    versionId: v.id,
    entityId: ad.entityId,
    storeId: ad.storeId,
    fileId: v.fileId,
    fileName: `${ad.adNo}_第${v.versionNo}版.mp4`,
    sizeBytes: f.sizeBytes.toString(),
    sha256: f.sha256,
    etag: f.etag,
  };
}
/** Sign first, then reacquire the current scope and exact source before recording access. */
export async function settleAdDownload(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  expected: Awaited<ReturnType<typeof prepareAdDownload>>,
) {
  await lockRows(tx, "entity", [actor.membership.entityId], "share");
  await lockRows(tx, "entity_member", [actor.membership.memberId], "share");
  await lockRows(tx, "store", [actor.membership.storeId], "share");
  await lockRows(tx, "ad", [expected.adId], "share");
  await lockRows(tx, "file_object", [expected.fileId], "share");
  const current = await prepareAdDownload(tx, deps, actor, expected.adId, expected.versionNo);
  if (
    current.versionId !== expected.versionId ||
    current.fileId !== expected.fileId ||
    current.sha256 !== expected.sha256 ||
    current.etag !== expected.etag ||
    current.sizeBytes !== expected.sizeBytes
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  await record(
    tx,
    actor.ctx.actor,
    {
      requestId: actor.ctx.requestId,
      ip: actor.ctx.ip,
      userAgent: actor.ctx.userAgent,
      authMethod: actor.principal ? "weapp" : null,
      sessionId: actor.principal?.sessionId ?? null,
      ...(actor.ctx.actor.client === "cli" ? { jobName: "cli.ad.download" } : {}),
    },
    {
      stream: "access",
      category: "file_access",
      action: "ad.version.album_download",
      summary: "签发广告相册保存地址",
      target: { type: "ad_version", id: current.versionId },
      entityId: current.entityId,
      storeId: current.storeId,
      meta: { versionNo: current.versionNo, fileCategory: "ad_video", urlTtlSec: 900 },
    },
  );
}
