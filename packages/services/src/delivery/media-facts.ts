import type { Tx } from "../kernel/index.js";

export async function readAdProductionKind(tx: Tx, adId: string): Promise<"head" | "tail" | null> {
  const ad = await tx.ad.findUnique({ where: { id: adId }, select: { type: true } });
  return ad?.type === "opening" ? "head" : ad?.type === "ending" ? "tail" : null;
}

/** IDs come from the persisted production context, never from an arbitrary file request. */
export async function readAdDurationFacts(
  tx: Tx,
  ids: { head: string | null; tail: string | null },
): Promise<{ headAdMs: number; tailAdMs: number } | null> {
  const requested = [...new Set([ids.head, ids.tail].filter((id): id is string => id !== null))];
  const rows = requested.length
    ? await tx.adVersion.findMany({
        where: { id: { in: requested } },
        select: { id: true, durationMs: true },
      })
    : [];
  if (
    requested.some(
      (id) => !rows.some((row) => row.id === id && row.durationMs !== null && row.durationMs > 0),
    )
  )
    return null;
  const duration = (id: string | null) =>
    id === null ? 0 : rows.find((row) => row.id === id)!.durationMs!;
  return { headAdMs: duration(ids.head), tailAdMs: duration(ids.tail) };
}
