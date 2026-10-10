import type { Tx } from "../kernel/index.js";
import { storeScope } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";

/** Same-transaction fact read for the process composition; missing stores stay missing. */
export async function readStoreMediaFacts(
  tx: Tx,
  storeId: string,
): Promise<{ name: string } | null> {
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { name: true } });
  return store?.name ? { name: store.name } : null;
}

/** Owned store facts used by the L4 asset composition. No missing store is synthesized. */
export function readStoreAssetFacts(tx: Tx, storeId: string, scope?: DataScope) {
  return tx.store.findFirst({
    where: { id: storeId, ...(scope ? storeScope(scope) : {}) },
    select: {
      id: true,
      entityId: true,
      name: true,
      isPrimary: true,
      qualificationStatus: true,
      lifecycle: true,
    },
  });
}

/** Historical uploader names stay scoped to their original entity. */
export async function readAssetMerchantUploader(
  tx: Tx,
  input: { entityId: string; merchantUserId: string },
) {
  const member = await tx.entityMember.findFirst({
    where: { entityId: input.entityId, merchantUserId: input.merchantUserId },
    select: { displayName: true },
    orderBy: { createdAt: "asc" },
  });
  return member?.displayName ?? null;
}
