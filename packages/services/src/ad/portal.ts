import { PlayableSchema } from "@liyoxi/contract";
import type { PortalAdListQuery, PortalAdPlaybackBody } from "@liyoxi/contract";
import type { PortalPrincipal } from "../identity/index.js";
import { AppError, createActor, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import type { PortalAdDeps } from "./portal-context.js";
import {
  portalAdMedia,
  portalAdPage,
  portalAdTarget,
  portalAdView,
  portalChannel,
} from "./portal-read.js";

async function prepare(
  tx: Tx,
  deps: PortalAdDeps,
  principal: PortalPrincipal,
  adId: string,
  versionNo: number,
) {
  const { ad, version } = await portalAdTarget(tx, principal, adId);
  if (ad.status === "cancelled" || !version) throw new AppError("STATE_NOT_ALLOWED");
  if (version.versionNo !== versionNo)
    throw new AppError("AD_VERSION_STALE", { details: { currentVersionNo: version.versionNo } });
  if (!portalChannel(version.previewChannels, await deps.playback(principal.entityId)))
    throw new AppError("AD_PREVIEW_CHANNEL_UNAVAILABLE", {
      details: { previewChannels: version.previewChannels },
    });
  const media = await portalAdMedia(tx, deps, adId, version.fileId, principal);
  if (!media.ready || !media.facts || !media.file)
    throw new AppError("PLAYABLE_UNAVAILABLE", {
      details: { state: media.facts?.asset.state ?? "pending" },
    });
  return { version, ...media, facts: media.facts, file: media.file };
}
const stamp = (value: Awaited<ReturnType<typeof prepare>>) =>
  JSON.stringify({
    versionId: value.version.id,
    fileId: value.file.id,
    objectKey: value.file.objectKey,
    sha256: value.file.sha256,
    etag: value.file.etag,
    size: value.file.sizeBytes?.toString(),
    asset: value.facts.asset,
    refs: value.facts.refs,
    renditions: value.facts.renditions,
    files: value.facts.files.map((file) => ({
      id: file.id,
      objectKey: file.objectKey,
      etag: file.etag,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes?.toString(),
      updatedAt: file.updatedAt,
    })),
    posterFileId: value.posterFileId,
  });

/** Portal-specific authority and evidence; never calls album download or merchant playback. */
export function createPortalAds(deps: PortalAdDeps) {
  const poster = (fileId: string | null) => (fileId ? deps.media.signRead({ fileId }) : null);
  return {
    async list(principal: PortalPrincipal, query: PortalAdListQuery) {
      const result = await deps.tx.run(async (tx) => {
        const current = await deps.assertPortalPrincipal(tx, principal, deps.clock.now());
        return portalAdPage(tx, deps, current, query, await deps.playback(current.entityId));
      });
      const items = [];
      for (const row of result.items)
        items.push({ ...row.card, poster: await poster(row.posterFileId) });
      return { ...result, items };
    },
    async get(principal: PortalPrincipal, adId: string) {
      const result = await deps.tx.run(async (tx) => {
        const current = await deps.assertPortalPrincipal(tx, principal, deps.clock.now());
        return portalAdView(tx, deps, current, adId, await deps.playback(current.entityId));
      });
      return { ...result.detail, poster: await poster(result.posterFileId) };
    },
    async playbackUrls(
      principal: PortalPrincipal,
      adId: string,
      input: PortalAdPlaybackBody,
      meta: AuditRequestMeta,
    ) {
      const first = await deps.tx.run(async (tx) => {
        const current = await deps.assertPortalPrincipal(tx, principal, deps.clock.now());
        return prepare(tx, deps, current, adId, input.versionNo);
      });
      // Technical signing is outside transactions. Neither provider failure nor stale authority records access.
      const signed = await deps.media.signRead({ fileId: first.file.id, audience: "merchant" });
      const cover = await poster(first.posterFileId);
      await deps.tx.run(async (tx) => {
        const current = await deps.assertPortalPrincipal(tx, principal, deps.clock.now(), {
          write: true,
        });
        await lockRows(tx, "ad", [adId], "share");
        await lockRows(tx, "playable_asset", [first.facts.asset.id], "share");
        await lockRows(
          tx,
          "file_object",
          [first.file.id, ...(first.posterFileId ? [first.posterFileId] : [])],
          "share",
        );
        const fresh = await prepare(tx, deps, current, adId, input.versionNo);
        if (
          stamp(first) !== stamp(fresh) ||
          Date.parse(signed.expiresAt) <= deps.clock.now().getTime()
        )
          throw new AppError("PLAYABLE_UNAVAILABLE", {
            details: { state: fresh.facts.asset.state },
          });
        await deps.assertPortalPrincipal(tx, current, deps.clock.now());
        await record(
          tx,
          createActor({
            type: "merchant",
            id: current.merchantUserId,
            client: "portal",
            role: "owner",
          }),
          { ...meta, authMethod: "portal", sessionId: current.sessionId },
          {
            stream: "access",
            category: "file_access",
            action: "ad.version.portal_preview",
            summary: "在电脑预览广告",
            target: { type: "ad_version", id: fresh.version.id },
            entityId: current.entityId,
            storeId: current.storeId,
            meta: { fileCategory: "ad_video", urlTtlSec: 3600 },
          },
        );
      });
      const source = first.facts.renditions?.[0];
      return PlayableSchema.parse({
        playableId: first.facts.asset.id,
        kind: "ad",
        durationMs: first.facts.asset.durationMs,
        width: first.facts.asset.width,
        height: first.facts.asset.height,
        posterUrl: cover?.url ?? null,
        sources: [
          {
            quality: "source",
            url: signed.url,
            width: first.version.width,
            height: first.version.height,
            bitrateKbps: source?.bitrateKbps ?? null,
          },
        ],
        expiresAt: signed.expiresAt,
        autoplay: false,
        muted: false,
      });
    },
  };
}
export type PortalAds = ReturnType<typeof createPortalAds>;
