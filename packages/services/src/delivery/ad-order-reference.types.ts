import type { Tx } from "../kernel/index.js";

export type AdOrderReference = {
  adId: string;
  orderId: string;
  orderItemId: string;
  slot: string;
  boundVersionNo: number | null;
  phase: string;
  active: boolean;
};

export type AdOrderReferenceReader = (
  tx: Tx,
  input: { entityId: string; storeId: string; adIds: readonly string[] },
) => Promise<readonly AdOrderReference[]>;
