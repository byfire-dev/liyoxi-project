import { PlanContentSchema } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
import { dateOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
export function adsReady(ticket: TicketRow) {
  return ticket.orderItem.orderItemPlacements.every(
    (p) => p.boundVersionNo !== null || p.ad.status === "confirmed",
  );
}
export async function planApplied(tx: Tx, dramaOrderId: string, snapshot: unknown) {
  const content = PlanContentSchema.parse(snapshot);
  const rows = await tx.orderItem.findMany({
    where: { dramaOrderId },
    include: { orderItemAccounts: true, orderItemPlacements: true },
  });
  for (const item of content.items) {
    const row = rows.find((r) => r.id === item.orderItemId);
    if (!row || !item.agreedLaunchDate || dateOf(row.agreedLaunchDate) !== item.agreedLaunchDate)
      return false;
    const accounts = (a: ReadonlyArray<{ channelAccountId: string; platform: string }>) =>
      a
        .map((r) => `${r.platform}:${r.channelAccountId}`)
        .sort()
        .join("|");
    if (accounts(row.orderItemAccounts) !== accounts(item.accounts)) return false;
    const placements = (a: ReadonlyArray<{ slot: string; adId: string; durationSec: number }>) =>
      a
        .map((r) => `${r.slot}:${r.adId}:${r.durationSec}`)
        .sort()
        .join("|");
    if (placements(row.orderItemPlacements) !== placements(item.placements)) return false;
  }
  const references = await tx.storeAssetUsage.findMany({
    where: { usedByType: "drama_order", usedById: dramaOrderId, role: "reference" },
    select: { storeAssetId: true },
  });
  if (content.referenceAssetIds.some((id) => !references.some((r) => r.storeAssetId === id)))
    return false;
  return true;
}
