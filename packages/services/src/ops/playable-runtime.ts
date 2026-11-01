import { isDeepStrictEqual } from "node:util";
import { PlayableSchema } from "@liyoxi/contract";
import type { Config } from "../config/index.js";
import { readTrailerMediaFacts } from "../content/index.js";
import { readAdPlayableFacts } from "../ad/index.js";
import { readSamplePlayableFacts } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, Tx, TxRunner } from "../kernel/index.js";
import { readMerchantPlayableAsset } from "../media/index.js";
import type { Media, MerchantPlayableAsset } from "../media/index.js";
import type { Tenant } from "../tenant/index.js";

export interface MerchantPlayableCaller {
  readonly merchantUserId?: string;
  readonly storeId?: string;
}
export interface MerchantPlayablesDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly config: Pick<Config, "flags">;
  readonly media: Pick<Media, "signRead" | "adProductionFacts" | "deliveryProductionFacts">;
  readonly tenant: Pick<Tenant, "resolveMembership">;
}
const unavailable = (state: string): never => {
  throw new AppError("PLAYABLE_UNAVAILABLE", { details: { state } });
};
function checkFiles(value: MerchantPlayableAsset) {
  const { asset, files, refs, renditions, posterFileId } = value;
  const live = (fileId: string, role: string) =>
    refs.some(
      (ref) =>
        ref.fileId === fileId &&
        ref.refType === "playable_asset" &&
        ref.refId === asset.id &&
        ref.role === role,
    );
  const usable = (fileId: string) => {
    const file = files.find((row) => row.id === fileId);
    if (
      !file ||
      file.status !== "stored" ||
      file.moderationState === "block" ||
      file.deletedAt ||
      file.erasedAt ||
      !file.etag ||
      !file.sha256 ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !file.sizeBytes
    )
      return unavailable(asset.state);
    return file;
  };
  const sameScope = (file: ReturnType<typeof usable>) =>
    file.entityId === asset.entityId &&
    file.storeId === asset.storeId &&
    file.scopeType === (asset.kind === "trailer" ? "platform" : "store");
  const source = usable(asset.sourceFileId);
  const sourceCategory =
    asset.kind === "trailer"
      ? "trailer_src"
      : asset.kind === "sample"
        ? "sample_video"
        : "ad_video";
  if (
    !sameScope(source) ||
    source.category !== sourceCategory ||
    source.bucket !== "media" ||
    !live(source.id, "source") ||
    !renditions?.length ||
    new Set(renditions.map((row) => row.quality)).size !== renditions.length
  )
    return unavailable(asset.state);
  for (const rendition of renditions) {
    const file = usable(rendition.fileId);
    const category =
      asset.kind === "trailer" ? "trailer_out" : asset.kind === "sample" ? "sample_wm" : "ad_video";
    if (
      !sameScope(file) ||
      file.category !== category ||
      file.bucket !== (asset.kind === "trailer" ? "pub" : "media") ||
      file.ext !== "mp4" ||
      !live(file.id, "rendition") ||
      (asset.kind === "trailer"
        ? !["sd", "hd"].includes(rendition.quality)
        : rendition.quality !== "source") ||
      (asset.kind === "ad" &&
        (file.id !== source.id ||
          rendition.width !== asset.width ||
          rendition.height !== asset.height))
    )
      return unavailable(asset.state);
  }
  if (asset.kind !== "trailer" && renditions.length !== 1) return unavailable(asset.state);
  if (posterFileId) {
    const file = usable(posterFileId);
    const coverRef = asset.coverFileId
      ? live(posterFileId, "cover")
      : refs.some(
          (ref) =>
            ref.fileId === posterFileId &&
            ref.refType === "media_info" &&
            ref.refId === asset.sourceFileId &&
            ref.role === "cover",
        );
    if (
      !coverRef ||
      !["video_cover", "poster"].includes(file.category) ||
      file.bucket !== (file.category === "poster" ? "pub" : "asset") ||
      !(
        sameScope(file) ||
        (file.category === "poster" &&
          file.scopeType === "platform" &&
          file.entityId === null &&
          file.storeId === null)
      )
    )
      return unavailable(asset.state);
  }
  return renditions;
}

/** Read-only L4 composition. Signing never grants ownership, channels, or production readiness. */
export function createMerchantPlayables(deps: MerchantPlayablesDeps) {
  async function inspect(tx: Tx, caller: MerchantPlayableCaller, playableId: string) {
    const value = await readMerchantPlayableAsset(tx, playableId);
    if (!value) throw new AppError("NOT_FOUND");
    const { asset } = value;
    const kind = asset.kind;
    if (kind !== "trailer" && kind !== "sample" && kind !== "ad") throw new AppError("NOT_FOUND");
    let membership: Awaited<ReturnType<Tenant["resolveMembership"]>> = null;
    let owner: unknown;
    if (kind === "trailer") {
      if (asset.ownerType !== "drama" || asset.entityId !== null || asset.storeId !== null)
        throw new AppError("NOT_FOUND");
      const trailer = await readTrailerMediaFacts(tx, asset.ownerId);
      if (!trailer || trailer.status !== "listed" || trailer.currentPlayableAssetId !== asset.id)
        throw new AppError("NOT_FOUND");
      owner = trailer;
    } else {
      if (!caller.merchantUserId) throw new AppError("AUTH_REQUIRED");
      if (!caller.storeId) throw new AppError("NOT_A_MEMBER");
      membership = await deps.tenant.resolveMembership(tx, {
        merchantUserId: caller.merchantUserId,
        storeId: caller.storeId,
      });
      if (!membership) throw new AppError("NOT_A_MEMBER");
      if (membership.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
      if (membership.storeMode !== "active") throw new AppError("STORE_ARCHIVED");
      if (asset.storeId !== membership.storeId || asset.entityId !== membership.entityId)
        throw new AppError("NOT_FOUND");
      if (kind === "ad") {
        if (asset.ownerType !== "ad") throw new AppError("NOT_FOUND");
        owner = await readAdPlayableFacts(tx, {
          adId: asset.ownerId,
          sourceFileId: asset.sourceFileId,
          entityId: membership.entityId,
          storeId: membership.storeId,
        });
      } else {
        if (asset.ownerType !== "order_item") throw new AppError("NOT_FOUND");
        owner = await readSamplePlayableFacts(tx, {
          orderItemId: asset.ownerId,
          sourceFileId: asset.sourceFileId,
          entityId: membership.entityId,
          storeId: membership.storeId,
        });
      }
      if (!owner) throw new AppError("NOT_FOUND");
    }
    const flag =
      kind === "trailer"
        ? "weapp.video.trailer.enabled"
        : kind === "sample"
          ? "weapp.video.sample.enabled"
          : "weapp.video.ad.enabled";
    await deps.config.flags.requireEnabled(flag, { entityId: asset.entityId });
    if (asset.state !== "ready" || asset.retiredAt || !asset.readyAt)
      return unavailable(asset.state);
    const renditions = checkFiles(value);
    let production: unknown = null;
    if (kind === "ad") {
      const actual = await deps.media.adProductionFacts(tx, asset.sourceFileId);
      if (
        !actual.ready ||
        actual.production?.kind !== "ad" ||
        actual.production.adId !== asset.ownerId ||
        !actual.playable ||
        actual.playable.id !== asset.id ||
        actual.playable.updatedAt.getTime() !== asset.updatedAt.getTime() ||
        !isDeepStrictEqual(actual.playable.renditions, asset.renditions) ||
        actual.durationMs !== asset.durationMs ||
        value.asset.sourceFile.mediaInfo?.displayWidth !== asset.width ||
        value.asset.sourceFile.mediaInfo?.displayHeight !== asset.height
      )
        return unavailable(asset.state);
      production = actual.production;
    } else if (kind === "sample") {
      const actual = await deps.media.deliveryProductionFacts(tx, asset.sourceFileId);
      if (
        !actual.ready ||
        actual.production?.kind !== "sample" ||
        actual.production.orderItemId !== asset.ownerId ||
        actual.durationMs !== asset.durationMs ||
        !actual.playable ||
        actual.playable.id !== asset.id ||
        actual.playable.updatedAt.getTime() !== asset.updatedAt.getTime() ||
        !isDeepStrictEqual(actual.playable.renditions, asset.renditions)
      )
        return unavailable(asset.state);
      production = actual.production;
    }
    const autoplay =
      kind === "trailer"
        ? await deps.config.flags.isEnabled("weapp.trailer.autoplay", { entityId: asset.entityId })
        : false;
    return {
      value,
      kind,
      renditions,
      autoplay,
      fence: { value, membership, owner, production, autoplay },
    };
  }
  return {
    async get(caller: MerchantPlayableCaller, playableId: string) {
      const before = await deps.tx.run((tx) => inspect(tx, caller, playableId));
      const audience = "merchant" as const;
      const poster = before.value.posterFileId
        ? await deps.media.signRead({ fileId: before.value.posterFileId, audience })
        : null;
      const sources = [];
      let expiresAt: string | null = null;
      for (const rendition of before.renditions) {
        const signed = await deps.media.signRead({ fileId: rendition.fileId, audience });
        sources.push({
          quality: rendition.quality,
          url: signed.url,
          width: rendition.width,
          height: rendition.height,
          bitrateKbps: rendition.bitrateKbps,
        });
        if (expiresAt === null || Date.parse(signed.expiresAt) < Date.parse(expiresAt))
          expiresAt = signed.expiresAt;
      }
      const after = await deps.tx.run((tx) => inspect(tx, caller, playableId));
      if (
        !isDeepStrictEqual(before.fence, after.fence) ||
        !expiresAt ||
        Date.parse(expiresAt) <= deps.clock.now().getTime() ||
        (poster !== null && Date.parse(poster.expiresAt) <= deps.clock.now().getTime())
      )
        return unavailable(after.value.asset.state);
      const asset = after.value.asset;
      return PlayableSchema.parse({
        playableId: asset.id,
        kind: after.kind,
        durationMs: asset.durationMs,
        width: asset.width,
        height: asset.height,
        posterUrl: poster?.url ?? null,
        sources,
        expiresAt,
        autoplay: after.autoplay,
        muted: after.kind === "trailer",
      });
    },
  };
}
export type MerchantPlayables = ReturnType<typeof createMerchantPlayables>;
