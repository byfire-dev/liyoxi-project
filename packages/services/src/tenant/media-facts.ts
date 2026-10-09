import type { Tx } from "../kernel/index.js";

/** Same-transaction fact read for the process composition; missing stores stay missing. */
export async function readStoreMediaFacts(
  tx: Tx,
  storeId: string,
): Promise<{ name: string } | null> {
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { name: true } });
  return store?.name ? { name: store.name } : null;
}
