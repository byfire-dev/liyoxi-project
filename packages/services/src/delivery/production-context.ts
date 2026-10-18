import type { Tx } from "../kernel/index.js";
import type { TicketRow } from "./repo.js";

/** Resolve only actual checkout/current master and the order's ad versions; never invent durations. */
export async function manualProductionContext(
  tx: Tx,
  t: TicketRow,
  staffId: string,
  episodeNo: number,
  declared?: string,
) {
  const checkout = declared
    ? null
    : await tx.masterCheckout.findUnique({
        where: {
          orderItemId_episodeNo_staffId: { orderItemId: t.orderItemId, episodeNo, staffId },
        },
      });
  const selected = declared ?? checkout?.dramaEpisodeMasterId;
  const master = selected
    ? await tx.dramaEpisodeMaster.findUnique({ where: { id: selected } })
    : await tx.dramaEpisodeMaster.findFirst({
        where: { dramaId: t.dramaId, episodeNo, isCurrent: true },
      });
  const validMaster =
    master?.dramaId === t.dramaId && master.episodeNo === episodeNo ? master : null;
  const version = async (slot: string) => {
    const p = t.orderItem.orderItemPlacements.find((r) => r.slot === slot);
    const versionNo = p?.boundVersionNo ?? p?.ad.confirmedVersionNo;
    if (!p || versionNo === null || versionNo === undefined) return null;
    return (
      (await tx.adVersion.findFirst({ where: { adId: p.adId, versionNo }, select: { id: true } }))
        ?.id ?? null
    );
  };
  return {
    dramaEpisodeMasterId: validMaster?.id,
    masterSource: validMaster
      ? declared
        ? ("declared" as const)
        : checkout
          ? ("checkout" as const)
          : ("current_fallback" as const)
      : undefined,
    headAdVersionId: await version("opening"),
    tailAdVersionId: await version("ending"),
  };
}
