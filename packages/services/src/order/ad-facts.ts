import type { DramaSnapshot } from "@liyoxi/contract";
import { readAdOrderFacts } from "../ad/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

const closed = ["cancelled", "refunded", "terminated", "ended"];
export async function readAdPlacementDetails(
  tx: Tx,
  input: { entityId: string; storeId: string; adId: string },
) {
  const rows = await tx.orderItemPlacement.findMany({
    where: { adId: input.adId, orderItem: { entityId: input.entityId, storeId: input.storeId } },
    include: { orderItem: { include: { dramaOrder: { select: { orderNo: true } } } } },
    orderBy: [{ orderItemId: "asc" }, { slot: "asc" }],
  });
  const active = rows.filter((row) => !closed.includes(row.orderItem.phase));
  const title = (snapshot: unknown) => {
    const value = snapshot as { title?: unknown };
    return typeof value?.title === "string" ? value.title : "";
  };
  return {
    placements: rows.map((row) => ({
      orderItemId: row.orderItemId,
      orderId: row.orderItem.dramaOrderId,
      orderNo: row.orderItem.dramaOrder.orderNo,
      dramaTitle: title(row.orderItem.dramaSnapshot),
      slot: row.slot,
      boundVersionNo: row.boundVersionNo,
      phase: row.orderItem.phase,
    })),
    usage: {
      inUseCount: new Set(active.map((row) => row.orderItemId)).size,
      firstDramaTitle: active[0] ? title(active[0].orderItem.dramaSnapshot) : null,
    },
    floatingPlacements: active
      .filter((row) => row.boundVersionNo === null)
      .map((row) => ({
        orderItemId: row.orderItemId,
        orderId: row.orderItem.dramaOrderId,
        orderNo: row.orderItem.dramaOrder.orderNo,
        dramaTitle: title(row.orderItem.dramaSnapshot),
        slot: row.slot,
        agreedLaunchDate: row.orderItem.agreedLaunchDate?.toISOString().slice(0, 10) ?? null,
      })),
  };
}
export async function readAdOrderReferences(
  tx: Tx,
  input: { entityId: string; storeId: string; adIds: readonly string[] },
) {
  if (!input.adIds.length) return [];
  const rows = await tx.orderItemPlacement.findMany({
    where: {
      adId: { in: [...input.adIds] },
      orderItem: { entityId: input.entityId, storeId: input.storeId },
    },
    include: { orderItem: { select: { dramaOrderId: true, phase: true } } },
    orderBy: [{ orderItemId: "asc" }, { slot: "asc" }],
  });
  return rows.map((row) => ({
    adId: row.adId,
    orderId: row.orderItem.dramaOrderId,
    orderItemId: row.orderItemId,
    slot: row.slot,
    boundVersionNo: row.boundVersionNo,
    phase: row.orderItem.phase,
    active: !closed.includes(row.orderItem.phase),
  }));
}

export async function selectableOrderAds(tx: Tx, scope: { entityId: string; storeId: string }) {
  const rows = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readAdOrderFacts(tx, { ...scope, cursor, limit: 100 });
    rows.push(
      ...page.rows.filter(
        (ad) =>
          ad.confirmedVersion &&
          ad.confirmedAt &&
          ad.status !== "cancelled" &&
          !ad.openCancelRequestId &&
          ["opening", "ending"].includes(ad.type),
      ),
    );
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}

/** Checkout holds all ad150 rows before the first account420 lock; late checks only reenter. */
export async function checkOrderAds(
  tx: Tx,
  scope: { entityId: string; storeId: string },
  ids: readonly string[],
  snapshots: ReadonlyMap<string, DramaSnapshot>,
) {
  await lockRows(tx, "ad", ids, "share");
  const { rows } = await readAdOrderFacts(tx, { ...scope, adIds: ids });
  const selected = [];
  const slots = new Set<string>();
  for (const id of ids) {
    const ad = rows.find((row) => row.adId === id);
    const fail = (reason: string, dramaId?: string): never => {
      throw new AppError("ORDER_AD_INVALID", {
        details: { adId: id, reason, ...(dramaId ? { dramaId } : {}) },
      });
    };
    if (!ad)
      throw new AppError("ORDER_AD_INVALID", { details: { adId: id, reason: "not_in_store" } });
    if (ad.status === "cancelled") fail("cancelled");
    if (ad.openCancelRequestId) fail("cancel_pending");
    if (!ad.confirmedVersion || !ad.confirmedAt) fail("not_confirmed");
    if (!["opening", "ending"].includes(ad.type) || slots.has(ad.type)) fail("slot_not_allowed");
    for (const [dramaId, snapshot] of snapshots)
      if (!snapshot.allowedPlacements.includes(ad.type as "opening" | "ending"))
        fail("slot_not_allowed", dramaId);
    slots.add(ad.type);
    selected.push(ad);
  }
  return selected;
}
