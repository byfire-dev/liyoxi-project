import type { IdentityContext, Tx } from "../kernel/index.js";
import { closeDeliveryPublish, readCancelReviewPublishTargets } from "./cancel-review-close.js";
import type { CancelReviewPublishTargets, CloseDeps } from "./cancel-review-close.js";

/** Read before locks: caller locks approval(30), the item/ticket, channel/release,
 * launch/patrol/takedown rows, and patrol follow-ups in the global order.
 * The writer rereads the full graph and rejects changes within the same transaction. */
export const readDeliveryPublishTargets = readCancelReviewPublishTargets;
export type DeliveryPublishTargets = CancelReviewPublishTargets;

export function closeExpiredDeliveryPublish(
  tx: Tx,
  deps: CloseDeps,
  ctx: IdentityContext,
  targets: DeliveryPublishTargets,
  input: { deliveryTicketId: string; now: Date },
) {
  return closeDeliveryPublish(tx, deps, ctx, targets, input, "expiry");
}

/** Copyright correction after order_item and ticket have their new values.
 * The ticket already entered takedown: existing tasks remain and checked tasks
 * keep their history. Only unchecked dates, snapshots and timers are resynced. */
export function resyncDeliveryPublishExpiry(
  tx: Tx,
  deps: CloseDeps,
  ctx: IdentityContext,
  targets: DeliveryPublishTargets,
  input: { deliveryTicketId: string; now: Date },
) {
  return closeDeliveryPublish(tx, deps, ctx, targets, input, "renewal");
}
