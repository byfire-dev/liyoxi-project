import { PortalDownloadBodySchema, PortalDownloadResultSchema } from "@liyoxi/contract";
import type { PortalDownloadBody } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { AuditRequestMeta } from "../../audit/index.js";
import type { PortalPrincipal } from "../../identity/index.js";
import { AppError, lockRows, trackOf, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { lockTickets } from "../repo.js";
import { readReleaseZipInput } from "../zip-package.js";
import { currentRelease, grantOf, itemInScope, manifestOf } from "./repo.js";
import {
  canRegenerate,
  fileAvailable,
  invalidGrant,
  unavailable,
  unavailableReason,
} from "./can-download.js";
import { remainingToday } from "./release.js";
import { portalSafeTitle } from "./portal-read.js";
import type { PortalDeliveryDownloadDeps } from "./portal-context.js";

async function authorized(
  tx: Tx,
  deps: PortalDeliveryDownloadDeps,
  request: PortalPrincipal,
  id: string,
) {
  const principal = await deps.assertPortalPrincipal(tx, request, deps.clock.now(), {
    write: true,
  });
  let item = await itemInScope(tx, principal, id);
  if (!item.deliveryTicket) unavailable("not_delivered");
  await lockTickets(tx, [item.deliveryTicket.id]);
  item = await itemInScope(tx, principal, id);
  const release = await currentRelease(tx, item),
    reason = unavailableReason(item, release, deps.clock.now());
  if (reason) unavailable(reason);
  if (!release) unavailable("not_delivered");
  await lockRows(tx, "delivery_release", [release.id]);
  const now = deps.clock.now();
  const grant = await grantOf(tx, release.id, item),
    remaining = await remainingToday(tx, item.id, now),
    regenerate = canRegenerate(item, release, now, remaining);
  if (!grant || grant.state !== "active" || grant.expiresAt <= now) invalidGrant(grant, regenerate);
  return { principal, item, release, grant, regenerate };
}
async function fresh(
  tx: Tx,
  deps: PortalDeliveryDownloadDeps,
  facts: Awaited<ReturnType<typeof authorized>>,
) {
  const now = deps.clock.now();
  await deps.assertPortalPrincipal(tx, facts.principal, now);
  const reason = unavailableReason(facts.item, facts.release, now);
  if (reason) unavailable(reason);
  if (facts.grant.expiresAt <= now) invalidGrant(facts.grant, facts.regenerate);
}
async function target(
  tx: Tx,
  deps: PortalDeliveryDownloadDeps,
  facts: Awaited<ReturnType<typeof authorized>>,
  body: PortalDownloadBody,
  final: boolean,
) {
  let fileId: string, fileName: string, sizeBytes: string | undefined;
  let zip: Awaited<ReturnType<PortalDeliveryDownloadDeps["media"]["ensureZip"]>> | null = null;
  if (body.kind === "episode") {
    const entry = manifestOf(facts.release.manifestSnapshot).find(
      (entry) => entry.episodeNo === body.episodeNo,
    );
    if (!entry || body.episodeNo > facts.release.episodeCount)
      throw new AppError("VALIDATION_FAILED", {
        details: { fieldErrors: [{ path: "episodeNo", message: "集号超出成片包范围" }] },
      });
    fileId = entry.fileId;
    fileName = entry.name;
    sizeBytes = entry.size;
  } else {
    try {
      const input = await readReleaseZipInput(tx, deps.media, facts.release.id, deps.clock.now());
      zip = await deps.media.ensureZip(
        tx,
        input,
        final || body.kind === "publish_list" ? { peek: true } : { retry: body.retry === true },
      );
      if (zip.zipState !== "ready") return { zip, file: null, fileName: null, sizeBytes: null };
      const id = body.kind === "zip" ? zip.zipFileId : zip.publishListFileId;
      if (!id) unavailable("file_unavailable");
      fileId = id;
      fileName =
        body.kind === "zip" ? input.zipFileName : `${portalSafeTitle(facts.item)}_发布清单.txt`;
    } catch (error) {
      if (
        error instanceof AppError &&
        ["FILE_NOT_AVAILABLE", "FILE_NOT_USABLE"].includes(error.error)
      )
        unavailable("file_unavailable");
      throw error;
    }
  }
  // ensureZip acquires ZIP(390) and the complete cache file set(410) first; never invert it.
  await lockRows(tx, "file_object", [fileId], "share");
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (
    !fileAvailable(file, facts.item) ||
    !file ||
    file.sizeBytes === null ||
    (sizeBytes !== undefined && file.sizeBytes.toString() !== sizeBytes)
  )
    unavailable("file_unavailable");
  return { zip, file, fileName, sizeBytes: sizeBytes ?? file.sizeBytes.toString() };
}
export async function portalDownloadUrls(
  deps: PortalDeliveryDownloadDeps,
  principal: PortalPrincipal,
  id: string,
  input: PortalDownloadBody,
  meta: AuditRequestMeta,
) {
  const parsed = PortalDownloadBodySchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  const body = parsed.data;
  const first = await deps.tx.run(async (tx) => {
    const facts = await authorized(tx, deps, principal, id);
    const selected = await target(tx, deps, facts, body, false);
    await fresh(tx, deps, facts);
    return { facts, target: selected };
  });
  if (!first.target.file)
    return PortalDownloadResultSchema.parse({
      kind: body.kind,
      state: first.target.zip!.zipState,
      episodeNo: null,
      downloadId: null,
      url: null,
      expiresAt: null,
      fileName: null,
      sizeBytes: null,
      pollAfterSec: body.kind === "zip" && first.target.zip!.zipState === "building" ? 5 : null,
    });
  const chosen = first.target.file;
  const signed = await deps.media
    .signDeliveryDownload({ fileId: chosen.id, fileName: first.target.fileName!, kind: body.kind })
    .catch((error: unknown) => {
      if (
        error instanceof AppError &&
        ["FILE_NOT_AVAILABLE", "FILE_NOT_USABLE"].includes(error.error)
      )
        unavailable("file_unavailable");
      throw error;
    });
  return deps.tx.run(async (tx) => {
    const current = await authorized(tx, deps, principal, id);
    if (
      current.release.id !== first.facts.release.id ||
      JSON.stringify(current.release.manifestSnapshot) !==
        JSON.stringify(first.facts.release.manifestSnapshot)
    )
      unavailable("release_closed");
    if (
      current.grant.id !== first.facts.grant.id ||
      current.grant.expiresAt.getTime() !== first.facts.grant.expiresAt.getTime()
    ) {
      const old = await tx.downloadGrant.findUnique({ where: { id: first.facts.grant.id } });
      invalidGrant(old, current.regenerate, "superseded");
    }
    const checked = await target(tx, deps, current, body, true),
      file = checked.file;
    await fresh(tx, deps, current);
    if (
      !file ||
      checked.zip?.zipBundleId !== first.target.zip?.zipBundleId ||
      checked.zip?.zipGen !== first.target.zip?.zipGen ||
      checked.zip?.zipFileId !== first.target.zip?.zipFileId ||
      checked.zip?.publishListFileId !== first.target.zip?.publishListFileId ||
      file.id !== chosen.id ||
      file.bucket !== chosen.bucket ||
      file.objectKey !== chosen.objectKey ||
      file.etag !== chosen.etag ||
      file.sizeBytes !== chosen.sizeBytes ||
      checked.fileName !== first.target.fileName ||
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
        kind: body.kind,
        episodeNo: body.kind === "episode" ? body.episodeNo : null,
        fileId: file.id,
        actorType: "merchant",
        actorId: current.principal.merchantUserId,
        client: "portal",
        urlTtlSec: body.kind === "zip" ? 10_800 : 900,
        ip: meta.ip,
        userAgent: meta.userAgent,
        createdAt: now,
      },
    });
    if (body.kind !== "publish_list")
      await trackOf(deps.assembly).record(tx, {
        name: "package_download",
        eventId: `srv-pkgdl-${current.release.id}-${current.principal.merchantUserId}-${body.kind}-${calendarDate(now)}`,
        subject: {
          userId: current.principal.merchantUserId,
          entityId: current.item.entityId,
          storeId: current.item.storeId,
        },
        props: { orderId: current.item.dramaOrderId, method: body.kind, channel: "portal" },
      });
    return PortalDownloadResultSchema.parse({
      kind: body.kind,
      state: "ready",
      episodeNo: body.kind === "episode" ? body.episodeNo : null,
      downloadId,
      ...signed,
      fileName: checked.fileName,
      sizeBytes: checked.sizeBytes,
      pollAfterSec: null,
    });
  });
}
