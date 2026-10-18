import type { BillingOrderContent, FulfillDone } from "@liyoxi/contract";
import type { BillingOrder } from "@liyoxi/db";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { createLedger, LedgerError } from "../ledger/index.js";
import type { LedgerClock } from "../ledger/index.js";
import type { FulfillDeps } from "./types.js";

type TopupContent = Extract<BillingOrderContent, { kind: "topup" }>;
export async function fulfillTopup(
  tx: Tx,
  deps: FulfillDeps,
  clock: LedgerClock,
  order: BillingOrder,
  content: TopupContent,
  ctx: IdentityContext,
): Promise<FulfillDone> {
  const result = await createLedger(deps).purchase(tx, {
    entityId: order.entityId,
    billingOrderId: order.id,
    points: content.points,
    payFen: content.payFen,
    ctx,
  });
  return {
    status: "done",
    effectiveAt: clock.now.toISOString(),
    termId: null,
    lotIds: [result.pointLotId],
    queuedBehindActive: false,
    notes: [],
  };
}
export async function previousTopup(
  tx: Tx,
  order: BillingOrder,
  content: TopupContent,
): Promise<FulfillDone> {
  const lot = await tx.pointLot.findUnique({
    where: {
      sourceType_sourceId_sourceNo: {
        sourceType: "purchase",
        sourceId: order.id,
        sourceNo: 0,
      },
    },
  });
  const operation = await tx.ledgerOperation.findUnique({
    where: { opKey: `purchase:billing_order:${order.id}` },
  });
  if (
    !lot ||
    !operation ||
    lot.entityId !== order.entityId ||
    lot.originalQty !== content.points ||
    lot.costBasisFen !== content.payFen
  )
    throw new LedgerError("guard", "已登记加购缺少匹配的入账批次");
  return {
    status: "done",
    effectiveAt: operation.occurredAt.toISOString(),
    termId: null,
    lotIds: [lot.id],
    queuedBehindActive: false,
    notes: [],
  };
}
