import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface AdCancelPointersInput {
  readonly entityId: string;
  readonly storeId: string;
  readonly cancelRequestId: string;
  readonly adIds: readonly string[];
  readonly now: Date;
}

/** Caller locks all requests/lines and ads before taking any order or ticket locks. */
export async function clearAdCancelRequestPointers(
  tx: Tx,
  input: AdCancelPointersInput,
): Promise<number> {
  const ids = [...new Set(input.adIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return 0;
  await lockRows(tx, "ad", ids);
  const scope = { entityId: input.entityId, storeId: input.storeId, id: { in: ids } };
  if ((await tx.ad.count({ where: scope })) !== ids.length) throw new AppError("NOT_FOUND");
  const changed = await tx.ad.updateMany({
    where: { ...scope, openCancelRequestId: input.cancelRequestId },
    data: {
      openCancelRequestId: null,
      lockVersion: { increment: 1 },
      updatedAt: input.now,
    },
  });
  return changed.count;
}
