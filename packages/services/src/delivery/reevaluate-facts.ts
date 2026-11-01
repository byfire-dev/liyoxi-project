import { readAdOrderFacts, readMaterialAdVersions } from "../ad/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import { PlanContentSchema } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
import { dateOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
export async function adsReady(tx: Tx, ticket: TicketRow) {
  const placements = ticket.orderItem.orderItemPlacements;
  if (!placements.length) return true;
  const { rows } = await readAdOrderFacts(tx, {
    entityId: ticket.entityId,
    storeId: ticket.storeId,
    adIds: placements.map((p) => p.adId),
  });
  const pinned = await readMaterialAdVersions(
    tx,
    placements.flatMap((p) =>
      p.boundVersionNo === null ? [] : [{ adId: p.adId, versionNo: p.boundVersionNo }],
    ),
  );
  const files = await readMaterialFileFacts(
    tx,
    pinned.map((v) => v.fileId),
  );
  const ready = placements.every((placement) => {
    const ad = rows.find((row) => row.adId === placement.adId);
    if (!ad || ad.status === "cancelled" || ad.openCancelRequestId) return false;
    if (placement.boundVersionNo === null)
      return ad.status === "confirmed" && !!ad.confirmedVersion?.mediaReady;
    const version = pinned.find(
        (v) => v.adId === placement.adId && v.versionNo === placement.boundVersionNo,
      ),
      file = version && files.find((value) => value.id === version.fileId);
    return (
      !!version &&
      version.entityId === ticket.entityId &&
      version.storeId === ticket.storeId &&
      version.decision === "confirmed" &&
      !!file &&
      file.status === "stored" &&
      file.moderationState !== "block" &&
      !file.deletedAt &&
      !file.erasedAt
    );
  });
  if (!ready || !["sample_making", "sample_confirm"].includes(ticket.step)) return ready;
  // A paused ticket may miss the entire reopen/confirm interval. Its old live sample
  // still has to be superseded when resuming after the new version is confirmed.
  const samples = await tx.sample.findMany({
    where: { deliveryTicketId: ticket.id, status: { in: ["uploaded", "qc_passed", "pushed"] } },
    select: { adVersionsUsed: true },
  });
  return samples.every((sample) =>
    placements.every((placement) => {
      const ad = rows.find((row) => row.adId === placement.adId),
        versionNo = placement.boundVersionNo ?? ad?.confirmedVersion?.versionNo;
      return (
        Array.isArray(sample.adVersionsUsed) &&
        sample.adVersionsUsed.some(
          (used) =>
            used &&
            typeof used === "object" &&
            !Array.isArray(used) &&
            used.adId === placement.adId &&
            used.slot === placement.slot &&
            used.versionNo === versionNo,
        )
      );
    }),
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
