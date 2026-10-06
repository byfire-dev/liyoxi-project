import { HoldStateError } from "../billing/index.js";
import { createTickets } from "../delivery/index.js";
import { createFlow } from "../flow/index.js";
import {
  alertsOf,
  AppError,
  createIdentityContext,
  lockRows,
  notifyReadOf,
} from "../kernel/index.js";
import type { FiredTimer, TimerOutcome, Tx } from "../kernel/index.js";
import { storeGate, storeLocation } from "../profile/index.js";
import { boundOrderStart } from "./start-binding.js";
import type { OrderStartBinding } from "./start-binding.js";
import { lockManagerBusiness, prepareStartStaff } from "./start-locks.js";

const checked = Symbol("order.start.captured");
export const isStartChecked = (args: unknown) => args === checked;

/** 已有事务的 timer 入口；所有资金、工单、历史与事件在此事务内。 */
export async function startOrder(
  tx: Tx,
  deps: OrderStartBinding,
  id: string,
): Promise<TimerOutcome> {
  const before = await tx.dramaOrder.findUnique({ where: { id }, include: { store: true } });
  if (!before || before.status !== "pending_start" || before.openCancelRequestId) return "skipped";
  if ((await storeGate(tx, before.storeId)) !== "full") return "skipped";
  const location = await storeLocation(tx, before.storeId);
  const selected = await prepareStartStaff(tx, deps, [{ ...before.store, ...location }], id);
  await lockManagerBusiness(tx, [before.storeId]);
  await lockRows(tx, "drama_order", [id]);
  const order = await tx.dramaOrder.findUniqueOrThrow({
    where: { id },
    include: { store: true, orderItems: { orderBy: { id: "asc" }, include: { pointHold: true } } },
  });
  if (
    order.status !== "pending_start" ||
    order.openCancelRequestId ||
    (await storeGate(tx, order.storeId)) !== "full"
  )
    return "skipped";
  if (order.store.deliveryManagerId !== before.store.deliveryManagerId) throw new AppError("BUSY");
  const items = order.orderItems;
  if (!items.length || items.some((i) => i.phase !== "pending_start"))
    throw new AppError("INTERNAL", { message: "待开工订单项不完整" });
  await lockRows(
    tx,
    "order_item",
    items.map((i) => i.id),
  );
  const ctx = createIdentityContext({
    actor: { type: "system", job: "order.start" },
    entityId: order.entityId,
    storeId: order.storeId,
  });
  const manager = selected.get(order.storeId);
  if (!order.store.deliveryManagerId && manager)
    await deps.assignManager(tx, ctx, { storeId: order.storeId, staffId: manager });
  let startedAt: Date | undefined;
  const captured: Array<{ id: string; at: Date }> = [];
  for (const item of items) {
    if (
      item.pointHold.refType !== "order_item" ||
      item.pointHold.refId !== item.id ||
      item.pointHold.entityId !== order.entityId ||
      item.pointHold.storeId !== order.storeId ||
      item.pointHold.qty !== item.chargePoints
    )
      throw new AppError("INTERNAL", { message: "订单项冻结引用不一致" });
    try {
      if (item.pointHold.status !== "held")
        throw new HoldStateError("capture", "not_held", item.pointHold);
      await deps.ledger.capture(tx, {
        pointHoldId: item.pointHoldId,
        title: { refType: "order_item", refNo: order.orderNo, count: 1 },
        ctx,
      });
    } catch (error) {
      if (error instanceof HoldStateError)
        await alertsOf(deps.assembly).raise({
          rule: "order.start_capture_failed",
          dimension: id,
          severity: "P1",
          detail: { dramaOrderId: id, pointHoldId: item.pointHoldId },
        });
      throw error;
    }
    // CaptureResult 未返回时点；只读取真实账本写下的 captured_at，不取账户锁前的时钟。
    const hold = await tx.pointHold.findUniqueOrThrow({ where: { id: item.pointHoldId } });
    if (!hold.capturedAt) throw new AppError("INTERNAL", { message: "扣减缺少真实时点" });
    startedAt ??= hold.capturedAt;
    captured.push({ id: item.id, at: hold.capturedAt });
  }
  const at = startedAt!;
  const flow = createFlow({
    assembly: deps.assembly,
    events: deps.events,
    clock: { now: () => new Date(at) },
  });
  for (const item of captured)
    await flow.transition(tx, ctx, {
      machine: "order_item",
      stateField: "phase",
      id: item.id,
      event: "order.start",
      to: "producing",
      args: checked,
      entityId: order.entityId,
      storeId: order.storeId,
      set: { phase_changed_at: item.at, captured_at: item.at },
      emit: { none: true, primary: "order.started" },
    });
  await flow.transition(tx, ctx, {
    machine: "drama_order",
    stateField: "status",
    id,
    event: "order.start",
    to: "producing",
    args: checked,
    entityId: order.entityId,
    storeId: order.storeId,
    set: {
      started_at: at,
      status_changed_at: at,
      sub_status: manager ? "plan_confirm" : "assigning",
    },
    // 主事件要携真实工单 id，等 createTickets 返回后在同一事务发出。
    emit: { none: true, primary: "order.started" },
  });
  const made = await createTickets(tx, deps, ctx, { dramaOrderId: id, at });
  await deps.events.emit(tx, ctx, {
    type: "order.started",
    aggregate: { type: "drama_order", id },
    entityId: order.entityId,
    storeId: order.storeId,
    dedupeKey: `order.started:${id}`,
    payload: {
      v: 1,
      dramaOrderId: id,
      entityId: order.entityId,
      storeId: order.storeId,
      orderItemIds: items.map((i) => i.id),
      deliveryTicketIds: made.deliveryTicketIds,
      fromState: "pending_start",
      toState: "producing",
      transition: "order.start",
    },
  });
  await notifyReadOf(deps.assembly).read(tx, "orderForNotify", id);
  // 开工事实是唯一 order.started；M7 按正式埋点目录补齐消费者，本包不自造未登记的直记键。
  return "fired";
}

/** 用例入口先只读预检；非待开工不进入锁/分配事务。 */
export async function startOrderUseCase(deps: OrderStartBinding, id: string) {
  const pending = await deps.tx.run((tx) =>
    tx.dramaOrder.findUnique({ where: { id }, select: { status: true } }),
  );
  if (pending?.status !== "pending_start") return "skipped" as const;
  return deps.tx.run((tx) => startOrder(tx, deps, id));
}
export async function handleOrderStart(tx: Tx, timer: FiredTimer) {
  if (timer.subjectType !== "drama_order" || !timer.subjectId) return "skipped" as const;
  return startOrder(tx, boundOrderStart(), timer.subjectId);
}
