import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import { storeGate, storeLocation } from "../profile/index.js";
import { boundOrderStart } from "./start-binding.js";
import type { OrderStartBinding } from "./start-binding.js";
import { lockManagerBusiness, prepareStartStaff } from "./start-locks.js";
import { armOrderStart, updateStartSubStatus } from "./start-timer.js";

export async function onQualificationDecided(
  tx: Tx,
  deps: OrderStartBinding,
  event: DeliveredEvent,
) {
  if (!["store.qualification.approved", "store.qualification.rejected"].includes(event.type))
    return;
  const { storeId, entityId } = event.payload;
  if (typeof storeId !== "string" || typeof entityId !== "string") return;
  await lockRows(tx, "store", [storeId]);
  const store = await tx.store.findFirst({ where: { id: storeId, entityId } });
  if (!store || store.lifecycle !== "active") return;
  // 延迟事件必须按当前事实决定，不能拿旧 approved 载荷越过当前资质结论。
  const full = (await storeGate(tx, storeId)) === "full";
  if (!full && store.qualificationStatus !== "rejected") return;
  const rows = await tx.dramaOrder.findMany({
    where: { storeId, entityId, status: "pending_start", openCancelRequestId: null },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "drama_order",
    rows.map((o) => o.id),
  );
  for (const row of rows) {
    const order = await tx.dramaOrder.findUniqueOrThrow({ where: { id: row.id } });
    if (order.status !== "pending_start" || order.openCancelRequestId) continue;
    if (full) await armOrderStart(tx, deps, order);
    await updateStartSubStatus(
      tx,
      order.id,
      full ? "starting" : "qualification_rejected",
      deps.clock.now(),
    );
  }
  // rejected_stale 与终局整店取消入口按任务 M5 留桩，本包不登记或假调用。
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
