import {
  DownloadBlockerSchema,
  IdSchema,
  PortalOrderItemListQuerySchema,
  PortalOrderItemPageSchema,
  PortalReleaseViewSchema,
} from "@liyoxi/contract";
import type { DownloadBlocker, PortalOrderItemListQuery } from "@liyoxi/contract";
import type { DeliveryRelease, DownloadGrant } from "@liyoxi/db";
import type { PortalPrincipal } from "../../identity/index.js";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { currentRelease, grantOf, itemInScope, manifestOf } from "./repo.js";
import type { DownloadItem } from "./repo.js";
import { unavailableReason } from "./can-download.js";
import type { PortalDeliveryDownloadDeps } from "./portal-context.js";

export function portalBlocker(
  item: DownloadItem,
  release: DeliveryRelease | null,
  grant: DownloadGrant | null,
  now: Date,
): DownloadBlocker | null {
  const reason = unavailableReason(item, release, now);
  if (reason) return { kind: "not_available", reason };
  if (!grant || grant.state !== "active" || grant.expiresAt <= now)
    return DownloadBlockerSchema.parse({
      kind: "grant_invalid",
      reason: !grant ? "missing" : grant.state === "active" ? "expired" : grant.state,
    });
  return null;
}
export const portalGrantView = (grant: DownloadGrant | null, now: Date) =>
  grant
    ? {
        state: grant.state,
        expiresAt: grant.expiresAt.toISOString(),
        isExpired: grant.expiresAt <= now,
      }
    : null;
export const portalReleaseBrief = (release: DeliveryRelease) => ({
  deliveryReleaseId: release.id,
  releaseNo: release.releaseNo,
  kind: release.kind,
  pushedAt: release.pushedAt.toISOString(),
  episodeCount: release.episodeCount,
  totalBytes: release.totalBytes.toString(),
  changedEpisodeNos: release.changedEpisodeNos,
});
export function portalTitle(item: DownloadItem) {
  return String((item.dramaSnapshot as { title?: string }).title ?? "成片");
}
export function portalSafeTitle(item: DownloadItem) {
  return portalTitle(item)
    .replace(/[\\/\p{Cc}\p{Cs}:*?"<>|]/gu, "_")
    .slice(0, 100)
    .replace(/\p{Cs}/gu, "_");
}
export async function portalRelease(
  tx: Tx,
  deps: PortalDeliveryDownloadDeps,
  principal: PortalPrincipal,
  id: string,
) {
  let scope = await deps.assertPortalPrincipal(tx, principal, deps.clock.now());
  const candidate = await itemInScope(tx, scope, id);
  if (candidate.deliveryTicket)
    await lockRows(tx, "delivery_ticket", [candidate.deliveryTicket.id], "share");
  scope = await deps.assertPortalPrincipal(tx, principal, deps.clock.now());
  const item = await itemInScope(tx, scope, id),
    release = await currentRelease(tx, item);
  if (!release) throw new AppError("NOT_FOUND");
  const now = deps.clock.now(),
    grant = await grantOf(tx, release.id, item),
    blocker = portalBlocker(item, release, grant, now);
  const logs = await tx.deliveryDownloadLog.findMany({
    where: {
      entityId: scope.entityId,
      storeId: scope.storeId,
      orderItemId: id,
      deliveryReleaseId: release.id,
      client: "portal",
      kind: "episode",
    },
    orderBy: { createdAt: "desc" },
  });
  const reason = release.reasonCode
    ? await tx.dictItem.findUnique({
        where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code: release.reasonCode } },
      })
    : null;
  return PortalReleaseViewSchema.parse({
    ...portalReleaseBrief(release),
    orderItemId: id,
    orderNo: item.dramaOrder.orderNo,
    dramaTitle: portalTitle(item),
    usageEndDate: item.usageEndDate.toISOString().slice(0, 10),
    state: release.state,
    closeReason: release.closeReason,
    reissueReason: release.reasonCode
      ? { code: release.reasonCode, name: reason?.name ?? release.reasonCode }
      : null,
    episodes: manifestOf(release.manifestSnapshot).map((entry) => ({
      episodeNo: entry.episodeNo,
      fileName: entry.name,
      sizeBytes: entry.size,
      isChanged: release.changedEpisodeNos.includes(entry.episodeNo),
      lastPortalDownloadAt:
        logs.find((log) => log.episodeNo === entry.episodeNo)?.createdAt.toISOString() ?? null,
    })),
    grant: portalGrantView(grant, now),
    isDownloadable: blocker === null,
    downloadBlocker: blocker,
    zipFileName: `${portalSafeTitle(item)}_全${release.episodeCount}集.zip`,
    hasPublishList: (release.publishListText?.length ?? 0) > 0,
  });
}
export async function portalList(
  deps: PortalDeliveryDownloadDeps,
  principal: PortalPrincipal,
  query: PortalOrderItemListQuery,
) {
  const parsed = PortalOrderItemListQuerySchema.safeParse(query);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED");
  const q = parsed.data;
  let cursor: { at: Date; id: string } | undefined;
  if (q.cursor) {
    try {
      const value = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8"));
      if (
        value.tab !== q.tab ||
        !IdSchema.safeParse(value.id).success ||
        typeof value.at !== "string" ||
        !Number.isFinite(Date.parse(value.at))
      )
        throw new Error();
      cursor = { at: new Date(value.at), id: value.id };
    } catch {
      cursor = undefined;
    }
  }
  const rows = await deps.tx.run(async (tx) => {
    const scope = await deps.assertPortalPrincipal(tx, principal, deps.clock.now());
    // Q9 excludes portal sample eligibility; a legacy sample-only item never enters this page.
    if (q.tab === "sample_pending") return [];
    const releases = await tx.deliveryRelease.findMany({
      where: {
        entityId: scope.entityId,
        storeId: scope.storeId,
        variant: "common",
        state: "pushed",
        orderItem: { phase: { notIn: ["cancelled", "refunded", "terminated", "ended"] } },
        deliveryTicket: { step: { not: "terminated" } },
        ...(cursor
          ? {
              OR: [
                { pushedAt: { lt: cursor.at } },
                { pushedAt: cursor.at, orderItemId: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ pushedAt: "desc" }, { orderItemId: "desc" }],
      take: q.limit + 1,
    });
    const result = [];
    for (const release of releases) {
      const item = await itemInScope(tx, scope, release.orderItemId),
        now = deps.clock.now(),
        grant = await grantOf(tx, release.id, item),
        blocker = portalBlocker(item, release, grant, now);
      result.push({
        item,
        card: {
          orderItemId: item.id,
          orderId: item.dramaOrderId,
          orderNo: item.dramaOrder.orderNo,
          dramaTitle: portalTitle(item),
          poster: null,
          episodeCount: item.episodeCount,
          phase: item.phase,
          usageEndDate: item.usageEndDate.toISOString().slice(0, 10),
          release: portalReleaseBrief(release),
          grant: portalGrantView(grant, now),
          isDownloadable: blocker === null,
          downloadBlocker: blocker,
          pendingSample: null,
          activityAt: release.pushedAt.toISOString(),
        },
      });
    }
    return result;
  });
  const hasMore = rows.length > q.limit,
    page = rows.slice(0, q.limit);
  const items = await Promise.all(
    page.map(async ({ item, card }) => {
      const fileId = (item.dramaSnapshot as { posterFileId?: string }).posterFileId;
      const poster = fileId
        ? await deps.media.signRead({ fileId, audience: "merchant" }).catch(() => null)
        : null;
      return { ...card, poster };
    }),
  );
  return PortalOrderItemPageSchema.parse({
    items,
    hasMore,
    nextCursor: hasMore
      ? Buffer.from(
          JSON.stringify({
            at: items.at(-1)!.activityAt,
            id: items.at(-1)!.orderItemId,
            tab: q.tab,
          }),
        ).toString("base64url")
      : null,
  });
}
