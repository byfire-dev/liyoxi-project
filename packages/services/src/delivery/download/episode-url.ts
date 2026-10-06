import { EpisodeDownloadBodySchema } from "@liyoxi/contract";
import type { EpisodeDownloadBody } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { AuditRequestMeta } from "../../audit/index.js";
import { AppError, lockRows, trackOf, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { DeliveryViewer } from "../context.js";
import type { DeliveryDownloadDeps } from "./context.js";
import {
  canDownload,
  canRegenerate,
  invalidGrant,
  unavailable,
  unavailableReason,
} from "./can-download.js";
import { currentRelease, grantOf, itemOf, lockParents, manifestOf, viewerOf } from "./repo.js";
import { remainingToday } from "./release.js";
async function facts(
  tx: Tx,
  deps: DeliveryDownloadDeps,
  v: DeliveryViewer,
  id: string,
  b: EpisodeDownloadBody,
) {
  const actor = await viewerOf(tx, v),
    item = await itemOf(tx, v, id),
    release = await currentRelease(tx, item),
    now = deps.clock.now();
  const reason = unavailableReason(item, release, now);
  if (reason) unavailable(reason);
  const grant = await grantOf(tx, release!.id, item),
    remaining = await remainingToday(tx, item.id, now),
    regenerate = canRegenerate(item, release, now, remaining);
  if (!grant || grant.state !== "active" || grant.expiresAt <= now) invalidGrant(grant, regenerate);
  const manifest = manifestOf(release!.manifestSnapshot),
    entry = manifest.find((e) => e.episodeNo === b.episodeNo);
  if (
    !Number.isInteger(b.episodeNo) ||
    b.episodeNo < 1 ||
    b.episodeNo > release!.episodeCount ||
    !entry
  )
    throw new AppError("VALIDATION_FAILED", {
      details: { fieldErrors: [{ path: "episodeNo", message: "集号超出成片包范围" }] },
    });
  const file = await tx.fileObject.findUnique({ where: { id: entry.fileId } });
  if (!canDownload(item, release, grant, now, [file])) unavailable("file_unavailable");
  return { actor, item, release: release!, grant: grant!, entry, file: file!, regenerate };
}
export async function episodeUrl(
  deps: DeliveryDownloadDeps,
  v: DeliveryViewer,
  id: string,
  input: EpisodeDownloadBody,
  meta: AuditRequestMeta,
) {
  const parsed = EpisodeDownloadBodySchema.safeParse(input);
  if (!parsed.success)
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  const first = await deps.tx.run((tx) => facts(tx, deps, v, id, parsed.data));
  const signed = await deps.media.signDeliveryDownload({
    fileId: first.file.id,
    fileName: first.entry.name,
  });
  return deps.tx.run(async (tx) => {
    if (!first.item.deliveryTicket) unavailable("not_delivered");
    await lockParents(tx, v, first.item.deliveryTicket.id);
    await lockRows(tx, "delivery_release", [first.release.id]);
    await lockRows(tx, "file_object", [first.file.id], "share");
    const current = await facts(tx, deps, v, id, parsed.data);
    if (
      current.release.id !== first.release.id ||
      JSON.stringify(current.release.manifestSnapshot) !==
        JSON.stringify(first.release.manifestSnapshot)
    )
      unavailable("release_closed");
    if (
      current.grant.id !== first.grant.id ||
      current.grant.expiresAt.getTime() !== first.grant.expiresAt.getTime()
    ) {
      const old = await tx.downloadGrant.findUnique({ where: { id: first.grant.id } });
      invalidGrant(old, current.regenerate, "superseded");
    }
    if (
      current.file.id !== first.file.id ||
      current.file.objectKey !== first.file.objectKey ||
      current.file.bucket !== first.file.bucket ||
      current.file.sizeBytes !== first.file.sizeBytes ||
      new Date(signed.expiresAt) <= deps.clock.now()
    )
      unavailable("file_unavailable");
    const downloadId = uuidv7(),
      now = deps.clock.now();
    await tx.deliveryDownloadLog.create({
      data: {
        id: downloadId,
        entityId: current.item.entityId,
        storeId: current.item.storeId,
        deliveryReleaseId: current.release.id,
        downloadGrantId: current.grant.id,
        orderItemId: id,
        kind: "episode",
        episodeNo: parsed.data.episodeNo,
        fileId: current.file.id,
        actorType: "merchant",
        actorId: current.actor.id,
        client: "weapp",
        urlTtlSec: 900,
        ip: meta.ip,
        userAgent: meta.userAgent,
        createdAt: now,
      },
    });
    await trackOf(deps.assembly).record(tx, {
      name: "package_download",
      eventId: `srv-pkgdl-${current.release.id}-${current.actor.id}-episode-${calendarDate(now)}`,
      subject: {
        userId: current.actor.id,
        entityId: current.item.entityId,
        storeId: current.item.storeId,
      },
      props: { orderId: current.item.dramaOrderId, method: "episode", channel: "weapp" },
    });
    return { ...signed, downloadId, fileName: current.entry.name, sizeBytes: current.entry.size };
  });
}
