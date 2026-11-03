import {
  DownloadGrantResultSchema,
  DownloadReportBodySchema,
  DownloadReportResultSchema,
} from "@liyoxi/contract";
import type { DownloadReportBody } from "@liyoxi/contract";
import { calendarDate, dayRange } from "@liyoxi/shared/time";
import { paramsAt } from "../../config/index.js";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { DeliveryViewer, DeliveryWriteOptions } from "../context.js";
import type { DeliveryDownloadDeps } from "./context.js";
import { currentRelease, itemOf, lockParents, viewerOf } from "./repo.js";
import { unavailable, unavailableReason } from "./can-download.js";
import { remainingToday } from "./release.js";

async function activeAccount(tx: Tx, viewer: DeliveryViewer, write = false) {
  const actor = viewer.ctx.actor;
  if (actor.type !== "merchant") throw new AppError("ROLE_FORBIDDEN");
  if (write) await lockRows(tx, "merchant_user", [actor.id], "share");
  const account = await tx.merchantUser.findUnique({
    where: { id: actor.id },
    select: { status: true },
  });
  if (account?.status !== "active") throw new AppError("SESSION_INVALID");
}

export async function createGrant(
  deps: DeliveryDownloadDeps,
  viewer: DeliveryViewer,
  id: string,
  options: DeliveryWriteOptions,
) {
  if (!options.idem) throw new AppError("INTERNAL");
  await deps.tx.run(async (tx) => {
    await viewerOf(tx, viewer);
    await activeAccount(tx, viewer);
  });
  return deps.tx.run(async (tx) => {
    await activeAccount(tx, viewer, true);
    const first = await itemOf(tx, viewer, id);
    if (!first.deliveryTicket) unavailable("not_delivered");
    await lockParents(tx, viewer, first.deliveryTicket.id);
    const actor = await viewerOf(tx, viewer),
      item = await itemOf(tx, viewer, id);
    const release = await currentRelease(tx, item);
    const reason = unavailableReason(item, release, deps.clock.now());
    if (reason) unavailable(reason);
    if (
      !release ||
      !["to_launch", "live"].includes(item.phase) ||
      !["awaiting_launch", "launch_verify", "in_service"].includes(item.deliveryTicket?.step ?? "")
    )
      unavailable("order_item_closed");
    await lockRows(tx, "delivery_release", [release.id]);
    const now = deps.clock.now(),
      afterWait = unavailableReason(item, release, now);
    if (afterWait) unavailable(afterWait);
    const remaining = await remainingToday(tx, id, now);
    if (!remaining)
      throw new AppError("DOWNLOAD_REGRANT_LIMIT", {
        details: { nextAvailableAt: dayRange(calendarDate(now)).end.toISOString() },
      });
    const validDays = (await paramsAt(tx, ["package.link_ttl_days"], now))["package.link_ttl_days"];
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 30)
      throw new AppError("INTERNAL");
    await tx.downloadGrant.updateMany({
      where: { orderItemId: id, state: "active" },
      data: { state: "superseded", endedAt: now, updatedAt: now },
    });
    const grant = await tx.downloadGrant.create({
      data: {
        id: uuidv7(),
        entityId: item.entityId,
        storeId: item.storeId,
        orderItemId: item.id,
        deliveryReleaseId: release.id,
        granteeType: "entity",
        granteeId: item.entityId,
        state: "active",
        validDays,
        expiresAt: new Date(now.getTime() + validDays * 86_400_000),
        actorType: "merchant",
        actorId: actor.id,
        client: "weapp",
        createdAt: now,
        updatedAt: now,
      },
    });
    return DownloadGrantResultSchema.parse({
      grant: {
        downloadGrantId: grant.id,
        state: grant.state,
        expiresAt: grant.expiresAt.toISOString(),
        validDays,
        isExpired: false,
        createdAt: now.toISOString(),
      },
      regrantRemainingToday: remaining - 1,
    });
  }, options);
}

export async function reportDownload(
  deps: DeliveryDownloadDeps,
  viewer: DeliveryViewer,
  id: string,
  input: DownloadReportBody,
  options: DeliveryWriteOptions,
) {
  if (!options.idem) throw new AppError("INTERNAL");
  const parsed = DownloadReportBodySchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  const actor = await deps.tx.run(async (tx) => {
    const actor = await viewerOf(tx, viewer);
    await activeAccount(tx, viewer);
    return actor;
  });
  return deps.tx.run(async (tx) => {
    await activeAccount(tx, viewer, true);
    const where = {
      id,
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      actorType: "merchant",
      actorId: actor.id,
      client: "weapp",
      kind: "episode",
    };
    const first = await tx.deliveryDownloadLog.findFirst({ where });
    if (!first) throw new AppError("NOT_FOUND");
    const item = await itemOf(tx, viewer, first.orderItemId);
    if (!item.deliveryTicket) throw new AppError("NOT_FOUND");
    await lockParents(tx, viewer, item.deliveryTicket.id);
    await viewerOf(tx, viewer);
    await lockRows(tx, "delivery_release", [first.deliveryReleaseId]);
    await tx.$queryRaw`SELECT id FROM delivery_download_log WHERE id=${id}::uuid FOR UPDATE`;
    const row = await tx.deliveryDownloadLog.findFirst({ where });
    if (!row || row.episodeNo === null) throw new AppError("NOT_FOUND");
    // The signed episode may finish saving after regrant/reissue/expiry. Record only that
    // historical download; current release progress is independently scoped by release ID.
    if (row.clientAck !== null && row.clientAck !== parsed.data.result)
      throw new AppError("STATE_NOT_ALLOWED");
    const saved =
      row.clientAck !== null
        ? row
        : await tx.deliveryDownloadLog.update({
            where: { id },
            data: { clientAck: parsed.data.result, clientAckAt: deps.clock.now() },
          });
    return DownloadReportResultSchema.parse({
      downloadId: saved.id,
      episodeNo: saved.episodeNo,
      clientAck: saved.clientAck,
      clientAckAt: saved.clientAckAt?.toISOString(),
    });
  }, options);
}
