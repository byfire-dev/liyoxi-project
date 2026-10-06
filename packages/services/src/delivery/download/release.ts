import { dayRange, calendarDate } from "@liyoxi/shared/time";
import type { DataScope } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { staffBriefs } from "../../staff/index.js";
import { getLaunchFacts } from "../../publish/index.js";
import type { DeliveryViewer } from "../context.js";
import { releaseAdminView } from "../packages.js";
import { dateOf, iso, ticketInclude } from "../repo.js";
import type { DeliveryDownloadDeps } from "./context.js";
import { canDownload, canRegenerate } from "./can-download.js";
import { currentRelease, grantOf, itemOf, manifestOf, scopedTickets, viewerOf } from "./repo.js";
export async function remainingToday(tx: Tx, itemId: string, now: Date) {
  const { start, end } = dayRange(calendarDate(now));
  return Math.max(
    0,
    5 -
      (await tx.downloadGrant.count({
        where: { orderItemId: itemId, actorType: "merchant", createdAt: { gte: start, lt: end } },
      })),
  );
}
export async function releaseView(
  tx: Tx,
  deps: DeliveryDownloadDeps,
  v: DeliveryViewer,
  id: string,
) {
  await viewerOf(tx, v);
  const item = await itemOf(tx, v, id),
    r = await currentRelease(tx, item);
  if (!r) throw new AppError("NOT_FOUND");
  const now = deps.clock.now(),
    grant = await grantOf(tx, r.id, item),
    manifest = manifestOf(r.manifestSnapshot),
    remaining = await remainingToday(tx, id, now);
  const saved = await tx.deliveryDownloadLog.findMany({
    where: {
      deliveryReleaseId: r.id,
      orderItemId: item.id,
      entityId: item.entityId,
      storeId: item.storeId,
      clientAck: "saved",
      kind: "episode",
    },
    orderBy: { clientAckAt: "desc" },
  });
  const files = await tx.fileObject.findMany({
    where: { id: { in: manifest.map((e) => e.fileId) } },
  });
  return {
    deliveryReleaseId: r.id,
    orderItemId: id,
    releaseNo: r.releaseNo,
    kind: r.kind,
    state: r.state,
    closeReason: r.closeReason,
    pushedAt: iso(r.pushedAt)!,
    episodeCount: r.episodeCount,
    totalBytes: r.totalBytes.toString(),
    changedEpisodeNos: r.changedEpisodeNos,
    episodes: manifest.map((e) => ({
      episodeNo: e.episodeNo,
      fileName: e.name,
      sizeBytes: e.size,
      isChanged: r.changedEpisodeNos.includes(e.episodeNo),
      lastSavedAt: iso(saved.find((s) => s.episodeNo === e.episodeNo)?.clientAckAt ?? null),
    })),
    savedEpisodeCount: new Set(saved.flatMap((s) => (s.episodeNo === null ? [] : [s.episodeNo])))
      .size,
    grant: grant
      ? {
          downloadGrantId: grant.id,
          state: grant.state,
          expiresAt: iso(grant.expiresAt)!,
          validDays: grant.validDays,
          isExpired: grant.expiresAt <= now,
          createdAt: iso(grant.createdAt)!,
        }
      : null,
    regrantRemainingToday: remaining,
    isDownloadable: canDownload(
      item,
      r,
      grant,
      now,
      manifest.map((e) => files.find((f) => f.id === e.fileId) ?? null),
    ),
    canRegenerate: canRegenerate(item, r, now, remaining),
  };
}
export async function adminReleaseView(
  tx: Tx,
  deps: DeliveryDownloadDeps,
  scope: DataScope,
  id: string,
) {
  const r = await tx.deliveryRelease.findFirst({
    where: { id, deliveryTicket: scopedTickets(scope) },
  });
  if (!r) throw new AppError("NOT_FOUND");
  const t = await tx.deliveryTicket.findFirst({
    where: {
      id: r.deliveryTicketId,
      entityId: r.entityId,
      storeId: r.storeId,
      orderItemId: r.orderItemId,
      ...scopedTickets(scope),
    },
    include: ticketInclude,
  });
  if (!t) throw new AppError("NOT_FOUND");
  if (
    t.orderItem.entityId !== t.entityId ||
    t.orderItem.storeId !== t.storeId ||
    t.orderItem.dramaOrderId !== t.dramaOrderId ||
    t.dramaOrder.entityId !== t.entityId ||
    t.dramaOrder.storeId !== t.storeId
  )
    throw new AppError("NOT_FOUND");
  const active = await tx.downloadGrant.findFirst({
    where: {
      deliveryReleaseId: id,
      orderItemId: r.orderItemId,
      entityId: r.entityId,
      storeId: r.storeId,
      granteeType: "entity",
      granteeId: r.entityId,
      state: "active",
      expiresAt: { gt: deps.clock.now() },
    },
  });
  const refs = await staffBriefs(
    tx,
    [t.deliveryManagerId, t.publisherId].filter((id): id is string => !!id),
  );
  const dict = async (code: string | null) => {
    const r = code
      ? await tx.dictItem.findUnique({
          where: { dictTypeKey_code: { dictTypeKey: "region", code } },
        })
      : null;
    return code ? { code, name: r?.name ?? code } : null;
  };
  return {
    ...(await releaseAdminView(tx, r)),
    ticket: {
      deliveryTicketId: t.id,
      ticketNo: t.ticketNo,
      step: t.step,
      isPaused: t.pauseCount > 0,
      pauseReasons: t.deliveryTicketPauses.map((p) => p.reason),
      deliveryManager: refs.find((s) => s.staffId === t.deliveryManagerId) ?? null,
      publisher: refs.find((s) => s.staffId === t.publisherId) ?? null,
      deliveryTargetAt: iso(t.deliveryTargetAt)!,
      deliveredAt: iso(t.deliveredAt),
    },
    orderItem: {
      orderItemId: t.orderItemId,
      orderId: t.dramaOrderId,
      orderNo: t.dramaOrder.orderNo,
      orderedAt: iso(t.dramaOrder.createdAt)!,
      dramaTitle: (t.orderItem.dramaSnapshot as { title: string }).title,
      episodeCount: t.orderItem.episodeCount,
      productionModel: t.orderItem.productionModel,
      phase: t.orderItem.phase,
      agreedLaunchDate: dateOf(t.orderItem.agreedLaunchDate),
      usageStartDate: dateOf(t.orderItem.usageStartDate),
      usageEndDate: dateOf(t.orderItem.usageEndDate)!,
      usageEndSource: t.orderItem.usageEndSource,
      liveEpisodeCount: (await getLaunchFacts(tx, t.orderItemId)).liveEpisodeCount,
    },
    store: {
      storeId: t.storeId,
      storeName: t.store.name,
      entityId: t.entityId,
      entityName: t.store.entity.name,
      city: await dict(t.store.storeProfileStore?.cityCode ?? null),
      district: await dict(t.store.storeProfileStore?.districtCode ?? null),
      qualificationStatus: t.store.qualificationStatus,
    },
    manifest: manifestOf(r.manifestSnapshot),
    publishListText: r.publishListText,
    activeGrant: active ? { downloadGrantId: active.id, expiresAt: iso(active.expiresAt)! } : null,
    actions: [] as string[],
  };
}
