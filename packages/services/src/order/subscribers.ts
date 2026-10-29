import { createIdentityContext } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import { storeLocation } from "../profile/index.js";
import { boundOrderStart } from "./start-binding.js";
import type { OrderStartBinding } from "./start-binding.js";
import { lockManagerBusiness, prepareStartStaff } from "./start-locks.js";
import { currentCancelRequests } from "./cancel-binding.js";
import type { CancelDeps } from "./cancel-context.js";
import { qualificationDecided } from "./qualification-followup.js";

export async function onQualificationDecided(
  tx: Tx,
  deps: OrderStartBinding,
  event: DeliveredEvent,
  cancel: CancelDeps | undefined = currentCancelRequests(),
) {
  return qualificationDecided(tx, deps, event, cancel);
}

export async function onSubscriptionActivated(
  tx: Tx,
  deps: OrderStartBinding,
  event: DeliveredEvent,
) {
  if (event.type !== "billing.subscription.activated" || typeof event.payload.entityId !== "string")
    return;
  const entityId = event.payload.entityId;
  const stores = await tx.store.findMany({
    where: { entityId, lifecycle: "active", deliveryManagerId: null },
    orderBy: { id: "asc" },
    select: { id: true, deliveryManagerId: true },
  });
  if (!stores.length) return;
  const located = [];
  for (const store of stores) located.push({ ...store, ...(await storeLocation(tx, store.id)) });
  const selected = await prepareStartStaff(tx, deps, located);
  if (![...selected.values()].some(Boolean)) return;
  await lockManagerBusiness(
    tx,
    stores.map((s) => s.id),
  );
  const ctx = createIdentityContext({
    actor: { type: "system", job: "order.subscription_activated" },
    entityId,
  });
  for (const before of stores) {
    const store = await tx.store.findUniqueOrThrow({ where: { id: before.id } }),
      staffId = selected.get(store.id);
    if (
      store.entityId !== entityId ||
      store.lifecycle !== "active" ||
      store.deliveryManagerId ||
      !staffId
    )
      continue;
    await deps.assignManager(tx, ctx, { storeId: store.id, staffId });
  }
}
export const handleQualificationDecided = (tx: Tx, event: DeliveredEvent) =>
  onQualificationDecided(tx, boundOrderStart(), event);
export const handleSubscriptionActivated = (tx: Tx, event: DeliveredEvent) =>
  onSubscriptionActivated(tx, boundOrderStart(), event);
