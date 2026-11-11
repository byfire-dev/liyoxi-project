import { createHash } from "node:crypto";
import { IdSchema, PortalAdCardSchema, PortalAdDetailSchema } from "@liyoxi/contract";
import type { PortalAdListQuery } from "@liyoxi/contract";
import type { PortalPrincipal } from "../identity/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { readAdPlayableAsset, readMaterialFileFacts } from "../media/index.js";
import type { PortalAdDeps } from "./portal-context.js";

export const portalChannel = (channels: readonly string[], enabled: boolean) =>
  channels.includes("portal") ||
  (!enabled &&
    channels.includes("weapp") &&
    channels.every((channel) => channel === "weapp" || channel === "wecom"));

export async function portalAdTarget(tx: Tx, principal: PortalPrincipal, adId: string) {
  const ad = await tx.ad.findFirst({
    where: { id: adId, entityId: principal.entityId, storeId: principal.storeId },
  });
  if (!ad) throw new AppError("NOT_FOUND");
  const version = await tx.adVersion.findFirst({
    where: { adId, pushedAt: { not: null } },
    orderBy: { versionNo: "desc" },
  });
  return { ad, version };
}
export async function portalAdMedia(
  tx: Tx,
  deps: PortalAdDeps,
  adId: string,
  fileId: string,
  principal: PortalPrincipal,
) {
  const facts = await readAdPlayableAsset(tx, {
    adId,
    fileId,
    entityId: principal.entityId,
    storeId: principal.storeId,
  });
  const file = (await readMaterialFileFacts(tx, [fileId]))[0];
  const production = await deps.media.adProductionFacts(tx, fileId);
  const ready =
    !!facts &&
    !!file &&
    production.ready &&
    production.playable?.id === facts.asset.id &&
    facts.asset.state === "ready" &&
    facts.asset.retiredAt === null &&
    file.category === "ad_video" &&
    file.scopeType === "store" &&
    file.entityId === principal.entityId &&
    file.storeId === principal.storeId &&
    file.status === "stored" &&
    file.moderationState !== "block" &&
    !file.deletedAt &&
    !file.erasedAt &&
    file.sizeBytes !== null &&
    file.etag !== null &&
    file.sha256 !== null &&
    facts.refs.some(
      (ref) =>
        ref.fileId === fileId &&
        ref.refType === "playable_asset" &&
        ref.refId === facts.asset.id &&
        ref.role === "source",
    );
  const posterId = facts?.posterFileId ?? file?.mediaInfo?.coverFileId ?? null;
  const poster = posterId ? (await readMaterialFileFacts(tx, [posterId]))[0] : null;
  const posterFileId =
    poster &&
    poster.status === "stored" &&
    poster.moderationState !== "block" &&
    !poster.deletedAt &&
    !poster.erasedAt &&
    poster.entityId === principal.entityId &&
    poster.storeId === principal.storeId
      ? poster.id
      : null;
  return { facts, file, ready, posterFileId };
}
export async function portalAdView(
  tx: Tx,
  deps: PortalAdDeps,
  principal: PortalPrincipal,
  adId: string,
  enabled: boolean,
) {
  const { ad, version } = await portalAdTarget(tx, principal, adId);
  if (!version?.pushedAt) throw new AppError("NOT_FOUND");
  const media = await portalAdMedia(tx, deps, adId, version.fileId, principal);
  const card = PortalAdCardSchema.parse({
    adId: ad.id,
    adNo: ad.adNo,
    type: ad.type,
    durationSec: ad.durationSec,
    status: ad.status,
    displayStatus: ["pending_assign", "producing", "returned"].includes(ad.status)
      ? "producing"
      : ad.status,
    copy: ad.copy,
    currentVersionNo: version.versionNo,
    currentVersionPushedAt: version.pushedAt.toISOString(),
    currentPreviewChannels: version.previewChannels,
    confirmedVersionNo: ad.confirmedVersionNo,
    poster: null,
    isPortalPreviewable:
      ad.status !== "cancelled" && portalChannel(version.previewChannels, enabled) && media.ready,
  });
  return {
    card,
    detail: PortalAdDetailSchema.parse({
      ...card,
      currentVersion: {
        versionNo: version.versionNo,
        pushedAt: version.pushedAt.toISOString(),
        durationMs: version.durationMs,
        width: version.width,
        height: version.height,
        segments: Array.isArray(version.segments) ? version.segments : [],
        previewChannels: version.previewChannels,
        decision: version.decision,
        decidedAt: version.decidedAt?.toISOString() ?? null,
      },
    }),
    posterFileId: media.posterFileId,
  };
}

export async function portalAdPage(
  tx: Tx,
  deps: PortalAdDeps,
  principal: PortalPrincipal,
  query: PortalAdListQuery,
  enabled: boolean,
) {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        principal.entityId,
        principal.storeId,
        [...new Set(query.status)].sort(),
        enabled,
      ]),
    )
    .digest("hex");
  let after: { at: string; id: string } | null = null;
  try {
    const value = query.cursor
      ? JSON.parse(Buffer.from(query.cursor, "base64url").toString())
      : null;
    if (
      value?.scope === scope &&
      IdSchema.safeParse(value.id).success &&
      typeof value.at === "string" &&
      Number.isFinite(Date.parse(value.at))
    )
      after = value;
  } catch {
    /* C42 corrupt or stale cursors restart the first page. */
  }
  const ids = await tx.$queryRaw<{ id: string; pushedAt: Date }[]>`
    SELECT a.id, v.pushed_at AS "pushedAt" FROM ad a
    JOIN LATERAL (SELECT pushed_at, preview_channels FROM ad_version
      WHERE ad_id=a.id AND pushed_at IS NOT NULL ORDER BY version_no DESC LIMIT 1) v ON true
    WHERE a.entity_id=${principal.entityId}::uuid AND a.store_id=${principal.storeId}::uuid
      AND a.status=ANY(${query.status}::text[])
      AND ('portal'=ANY(v.preview_channels) OR (${!enabled} AND 'weapp'=ANY(v.preview_channels)
        AND v.preview_channels <@ ARRAY['weapp','wecom']::text[]))
      AND (${after === null} OR v.pushed_at < ${after ? new Date(after.at) : null}::timestamptz
        OR (v.pushed_at=${after ? new Date(after.at) : null}::timestamptz AND a.id < ${after?.id ?? null}::uuid))
    ORDER BY v.pushed_at DESC, a.id DESC LIMIT ${query.limit + 1}`;
  const page = ids.slice(0, query.limit),
    last = page.at(-1);
  const items = [];
  for (const row of page) {
    const view = await portalAdView(tx, deps, principal, row.id, enabled);
    if (portalChannel(view.card.currentPreviewChannels, enabled)) items.push(view);
  }
  return {
    items,
    hasMore: ids.length > query.limit,
    nextCursor:
      ids.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({ scope, at: last.pushedAt.toISOString(), id: last.id }),
          ).toString("base64url")
        : null,
  };
}
