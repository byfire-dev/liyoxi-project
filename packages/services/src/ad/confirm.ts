import { AdConfirmBodySchema } from "@liyoxi/contract";
import type { AdConfirmBody } from "@liyoxi/contract";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { AdActor, AdConfirmChange, AdWriteDeps } from "./context.js";
import { member, merchantAd, moveAd, noCancel } from "./lifecycle.js";

export async function adViewEvidence(tx: Tx, adId: string, versionNo: number) {
  const version = await tx.adVersion.findUnique({
    where: { adId_versionNo: { adId, versionNo } },
    select: { id: true },
  });
  if (!version) return { albumSavedAt: null, portalViewedAt: null };
  const logs = await tx.auditLog.findMany({
    where: {
      stream: "access",
      targetType: "ad_version",
      targetId: version.id,
      action: { in: ["ad.version.album_download", "ad.version.portal_preview"] },
    },
    orderBy: { createdAt: "asc" },
  });
  const matching = logs;
  return {
    albumSavedAt:
      matching.find((log) => log.action === "ad.version.album_download")?.createdAt ?? null,
    portalViewedAt:
      matching.find((log) => log.action === "ad.version.portal_preview")?.createdAt ?? null,
  };
}
/** Ops prelocks the complete impact graph and invokes delivery reevaluation in this same transaction. */
export async function confirmAdTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  adId: string,
  input: AdConfirmBody,
): Promise<AdConfirmChange> {
  const body = AdConfirmBodySchema.parse(input);
  await member(tx, actor, true);
  await lockRows(tx, "ad", [adId]);
  const ad = await merchantAd(tx, actor, adId);
  noCancel(ad);
  const version = await tx.adVersion.findFirst({
    where: { adId, pushedAt: { not: null } },
    orderBy: { versionNo: "desc" },
  });
  if (!version || version.versionNo !== body.versionNo)
    throw new AppError("AD_VERSION_STALE", {
      details: { currentVersionNo: version?.versionNo ?? null },
    });
  if (ad.status !== "pending_confirm" || version.decision !== null)
    throw new AppError("STATE_NOT_ALLOWED");
  if (!version.previewChannels.includes(body.viewedVia))
    throw new AppError("AD_PREVIEW_CHANNEL_UNAVAILABLE", {
      details: { previewChannels: version.previewChannels },
    });
  const enabled = await deps.playback(ad.entityId),
    evidence = await adViewEvidence(tx, ad.id, version.versionNo);
  const notViewed = (requiredEvidence: "album_saved" | "portal_viewed" | "album_or_portal") =>
    new AppError("AD_NOT_VIEWED", { details: { viewedVia: body.viewedVia, requiredEvidence } });
  if (body.viewedVia === "weapp" && enabled) {
    const production = await deps.media.adProductionFacts(tx, version.fileId);
    if (!production.ready || !production.playable)
      throw new AppError("PLAYABLE_UNAVAILABLE", { details: { state: "not_ready" } });
  } else {
    if (!body.hasViewed)
      throw new AppError("VALIDATION_FAILED", {
        details: { fieldErrors: [{ path: "hasViewed", message: "请勾选已查看本版广告" }] },
      });
    if (body.viewedVia === "album" && !evidence.albumSavedAt) throw notViewed("album_saved");
    if (body.viewedVia === "portal" && !evidence.portalViewedAt) throw notViewed("portal_viewed");
    if (body.viewedVia === "weapp" && !evidence.albumSavedAt && !evidence.portalViewedAt)
      throw notViewed("album_or_portal");
    if (body.viewedVia === "wecom" && !version.offlineSentAt)
      throw new AppError("AD_PREVIEW_CHANNEL_UNAVAILABLE", {
        details: { previewChannels: version.previewChannels },
      });
  }
  const now = deps.clock.now();
  await tx.adVersion.update({
    where: { id: version.id },
    data: {
      decision: "confirmed",
      decidedAt: now,
      confirmViewedVia: body.viewedVia,
      viewedAckAt: body.hasViewed ? now : null,
      updatedAt: now,
    },
  });
  await moveAd(
    tx,
    deps,
    actor.ctx,
    ad,
    "ad.confirm",
    "09:806",
    {
      confirmed_version_no: version.versionNo,
      confirmed_at: now,
      due_at: null,
      sla_snapshot: null,
    },
    {
      type: "ad.confirmed",
      payload: { v: 1, adId, versionNo: version.versionNo, viewedVia: body.viewedVia },
    },
    { versionNo: version.versionNo },
  );
  return { adId, versionNo: version.versionNo, previousConfirmedVersionNo: ad.confirmedVersionNo };
}
