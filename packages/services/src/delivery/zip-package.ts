import { ReleaseManifestItemSchema } from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import type { EnsureZipInput, Media } from "../media/index.js";
import { record } from "../audit/index.js";
import { lockTickets } from "./repo.js";
import { scopedTickets } from "./download/repo.js";
import { invalidGrant } from "./download/can-download.js";
import type { DeliveryWriteOptions } from "./context.js";

type ZipMedia = Pick<Media, "ensureZip" | "readZipSourceFiles">;
export interface DeliveryZipPackagesDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly media: ZipMedia;
}

/** Immutable release facts and the owning domain's grant deadline; no reads of media's cache. */
export async function readReleaseZipInput(
  tx: Tx,
  media: ZipMedia,
  releaseId: string,
  now: Date,
): Promise<EnsureZipInput> {
  const release = await tx.deliveryRelease.findUnique({
    where: { id: releaseId },
    include: { orderItem: true },
  });
  if (!release) throw new AppError("NOT_FOUND");
  if (release.state !== "pushed") throw new AppError("STATE_NOT_ALLOWED");
  const grants = await tx.downloadGrant.findMany({
    where: {
      deliveryReleaseId: release.id,
      entityId: release.entityId,
      storeId: release.storeId,
      orderItemId: release.orderItemId,
      granteeType: "entity",
      granteeId: release.entityId,
    },
    orderBy: [{ expiresAt: "desc" }, { id: "asc" }],
  });
  const active = grants.filter((grant) => grant.state === "active" && grant.expiresAt > now);
  if (!active.length) invalidGrant(grants[0] ?? null, false);
  const manifest = ReleaseManifestItemSchema.array().parse(release.manifestSnapshot);
  if (
    manifest.length !== release.episodeCount ||
    manifest.some((item, index) => item.episodeNo !== index + 1) ||
    new Set(manifest.map((item) => item.fileId)).size !== manifest.length ||
    manifest.reduce((total, item) => total + BigInt(item.size), 0n) !== release.totalBytes
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const files = await media.readZipSourceFiles(tx, {
    fileIds: manifest.map((item) => item.fileId),
    entityId: release.entityId,
    storeId: release.storeId,
  });
  const names = new Set<string>();
  const items = manifest.map((entry) => {
    const file = files.find((file) => file.fileId === entry.fileId);
    if (!file || file.size !== entry.size || (entry.crc64 !== null && entry.crc64 !== file.crc64))
      throw new AppError("FILE_NOT_AVAILABLE");
    // Content titles are not filesystem paths. Keep the immutable manifest intact,
    // and map archive members to flat portable names with a deterministic collision suffix.
    const cleaned = entry.name.replace(/[\\/\p{Cc}\p{Cs}:*?"<>|]/gu, "_");
    const stem =
      cleaned
        .replace(/\.mp4$/iu, "")
        .slice(0, 220)
        .replace(/\p{Cs}/gu, "_") || "成片";
    let name = `${stem}.mp4`;
    let collision = 0;
    while (names.has(name)) name = `${stem}_第${entry.episodeNo}集_${++collision}.mp4`;
    names.add(name);
    return { ...file, name, crc64: entry.crc64 };
  });
  const title = String((release.orderItem.dramaSnapshot as { title?: string }).title ?? "成片")
    .replace(/[\\/\p{Cc}\p{Cs}:*?"<>|]/gu, "_")
    .slice(0, 100)
    .replace(/\p{Cs}/gu, "_");
  return {
    ownerType: "delivery_release",
    ownerId: release.id,
    entityId: release.entityId,
    storeId: release.storeId,
    orderItemId: release.orderItemId,
    items,
    publishListText: release.publishListText,
    keepUntil: new Date(Math.max(...active.map((grant) => grant.expiresAt.getTime())) + 86_400_000),
    zipFileName: `${title}_全${release.episodeCount}集.zip`,
  };
}

export function createDeliveryZipPackages(deps: DeliveryZipPackagesDeps) {
  return {
    pack: async (
      ctx: IdentityContext,
      staff: StaffContext,
      releaseId: string,
      options: DeliveryWriteOptions = {},
    ) => {
      assertPermission(staff, "publish.package.push", deps.clock.now());
      return deps.tx.run(async (tx) => {
        const release = await tx.deliveryRelease.findFirst({
          where: {
            id: releaseId,
            deliveryTicket: scopedTickets(staff.scope),
          },
        });
        if (!release) throw new AppError("NOT_FOUND");
        await lockTickets(tx, [release.deliveryTicketId]);
        await lockRows(tx, "delivery_release", [release.id]);
        const current = await tx.deliveryRelease.findFirst({
          where: { id: release.id, deliveryTicket: scopedTickets(staff.scope) },
          select: { id: true },
        });
        if (!current) throw new AppError("NOT_FOUND");
        const input = await readReleaseZipInput(tx, deps.media, release.id, deps.clock.now());
        const result = await deps.media.ensureZip(tx, input, { retry: true });
        await record(
          tx,
          ctx.actor,
          {
            requestId: ctx.requestId,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            authMethod: null,
            sessionId: null,
          },
          {
            stream: "activity",
            category: "delivery",
            action: "delivery.release.pack",
            summary: "预打包成片",
            target: { type: "delivery_release", id: release.id },
            entityId: input.entityId,
            storeId: input.storeId,
          },
        );
        return { deliveryReleaseId: release.id, ...result };
      }, options);
    },
  };
}
