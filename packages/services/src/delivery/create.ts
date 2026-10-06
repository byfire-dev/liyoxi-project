import { PlanContentSchema } from "@liyoxi/contract";
import { paramsAt } from "../config/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { pickNext } from "../staff/index.js";
import { createFlow } from "../flow/index.js";
import { workHoursAt } from "../sla/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { checked } from "./machines.js";
import { itemInclude } from "./repo.js";
import { orderSidePort } from "./ports.js";
const selections = new WeakMap<Tx, Map<string, { publisherId: string | null }>>();
/** W1-17 在 staff 20 阶段调本函数，随后才锁订单/订单项及最后的计费账户。 */
export async function prepareTicketAssignees(tx: Tx, dramaOrderId: string) {
  const known = selections.get(tx)?.get(dramaOrderId);
  if (known) return known;
  const order = await tx.dramaOrder.findUnique({ where: { id: dramaOrderId } });
  if (!order) throw new AppError("NOT_FOUND");
  const publisher = await pickNext(tx, "publisher", order.storeId);
  const value = { publisherId: publisher?.staffId ?? null };
  const byOrder = selections.get(tx) ?? new Map();
  byOrder.set(dramaOrderId, value);
  selections.set(tx, byOrder);
  return value;
}
export async function createTickets(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  input: { dramaOrderId: string; at?: Date },
) {
  const selection = selections.get(tx)?.get(input.dramaOrderId);
  if (!selection)
    throw new AppError("INTERNAL", { message: "建工单前必须在同事务的员工锁阶段准备分配" });
  await lockRows(tx, "drama_order", [input.dramaOrderId]);
  const order = await tx.dramaOrder.findUniqueOrThrow({
    where: { id: input.dramaOrderId },
    include: {
      store: true,
      subscriptionTerm: true,
      orderItems: { include: itemInclude, orderBy: { itemNo: "asc" } },
    },
  });
  const items = order.orderItems.filter(
    (r) => !["cancelled", "refunded", "terminated"].includes(r.phase),
  );
  await lockRows(
    tx,
    "order_item",
    items.map((r) => r.id),
  );
  const previous = await tx.deliveryTicket.findMany({ where: { dramaOrderId: order.id } });
  const existingPlan = await tx.deliveryPlan.findUnique({ where: { dramaOrderId: order.id } });
  if (previous.length || existingPlan) {
    if (previous.length === items.length && existingPlan)
      return { deliveryPlanId: existingPlan.id, deliveryTicketIds: previous.map((r) => r.id) };
    throw new AppError("INTERNAL", { message: "订购单开工产物不完整" });
  }
  // W1-17 传首次 capture 返回的 Tf；局部固定时钟令新建行、首历史、环节与 SLA 使用同一真实时点。
  const now = input.at ? new Date(input.at) : deps.clock.now();
  if (!Number.isFinite(now.getTime())) throw new TypeError("开工时间必须有效");
  const flow = input.at
    ? createFlow({
        assembly: deps.assembly,
        clock: { now: () => new Date(now) },
        events: deps.events,
      })
    : deps.flow;
  const values = await paramsAt(tx, ["sla.delivery.target"], now),
    target = await deps.sla.dueAt(tx, {
      policy: "delivery.target",
      ...values["sla.delivery.target"],
      from: now,
      workHours: await workHoursAt(tx, now),
    });
  const planId = uuidv7(),
    managerId = order.store.deliveryManagerId;
  const rights = order.subscriptionTerm;
  const usages = await tx.storeAssetUsage.findMany({
    where: { usedByType: "drama_order", usedById: order.id, role: "reference" },
    orderBy: { storeAssetId: "asc" },
  });
  const draft = PlanContentSchema.parse({
    focusTags: order.focusCodes,
    referenceAssetIds: usages.map((r) => r.storeAssetId),
    note: order.note,
    launchMode: "merchant_self",
    items: items.map((r) => ({
      orderItemId: r.id,
      accounts: r.orderItemAccounts.map((a) => ({
        channelAccountId: a.channelAccountId,
        platform: a.platform,
      })),
      placements: r.orderItemPlacements.map((p) => ({
        slot: p.slot,
        adId: p.adId,
        durationSec: p.durationSec,
      })),
      agreedLaunchDate: r.agreedLaunchDate?.toISOString().slice(0, 10) ?? null,
      expectedDeliveryDate: null,
    })),
  });
  await tx.deliveryPlan.create({
    data: {
      id: planId,
      entityId: order.entityId,
      storeId: order.storeId,
      dramaOrderId: order.id,
      status: "drafting",
      draft,
      createdAt: now,
      updatedAt: now,
    },
  });
  const ids: string[] = [];
  for (const item of items) {
    const id = uuidv7();
    ids.push(id);
    await tx.deliveryTicket.create({
      data: {
        id,
        ticketNo: `JF${order.orderNo.replace(/^LYX/, "")}-${item.itemNo}`,
        entityId: order.entityId,
        storeId: order.storeId,
        dramaOrderId: order.id,
        orderItemId: item.id,
        dramaId: item.dramaId,
        step: managerId ? "plan_confirm" : "assigning",
        stepEnteredAt: now,
        waitingOn: "staff",
        deliveryManagerId: managerId,
        publisherId: selection.publisherId,
        schedulePriority: rights.schedulePriority ?? "standard",
        deliveryTargetAt: target.dueAt,
        assignedAt: managerId ? now : null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await flow.transition(tx, ctx, {
      machine: "delivery_ticket",
      stateField: "step",
      id,
      event: "ticket.created",
      to: managerId ? "plan_confirm" : "assigning",
      created: true,
      entityId: order.entityId,
      storeId: order.storeId,
      args: checked(),
      emit: {
        type: "ticket.created",
        payload: {
          v: 1,
          deliveryTicketId: id,
          dramaOrderId: order.id,
          orderItemId: item.id,
          deliveryManagerId: managerId,
        },
      },
    });
  }
  if (items.length)
    await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: items.map((i) => i.id) });
  return { deliveryPlanId: planId, deliveryTicketIds: ids };
}
