import { PricingSnapshotSchema } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";

/** Historical advertisement pricing identifies its plan, never the store's current subscription. */
export async function readAdPricingPlanName(tx: Tx, snapshot: unknown) {
  const pricing = PricingSnapshotSchema.parse(snapshot);
  const plan = await tx.plan.findUnique({ where: { id: pricing.planId }, select: { name: true } });
  return plan?.name ?? null;
}
