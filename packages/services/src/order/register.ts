import { chainKey, machinePort, rowKey } from "../flow/index.js";
import {
  defineRegistration,
  implement,
  implementKeyed,
  implementMerchantFacts,
  lockRows,
} from "../kernel/index.js";
import { orderManagerPort } from "../profile/index.js";
import type { SyncStoreManager } from "../profile/index.js";
import { orderSidePort } from "../delivery/index.js";
import { boundOrder } from "./binding.js";
import { applyConfirmedPlan } from "./plan.js";
import { rederive, isDerivationChecked } from "./rederive.js";
import { DERIVED_INVARIANT_CODES, findDerivedViolations } from "./derived-invariants.js";
import { findOrderViolations, ORDER_INVARIANT_CODES } from "./invariants.js";
import { orderMerchantFacts } from "./counts.js";
export const syncOrderManager: SyncStoreManager = async (tx, input) => {
  const rows = await tx.dramaOrder.findMany({
    where: {
      storeId: input.storeId,
      entityId: input.entityId,
      status: { notIn: ["ended", "cancelled", "refunded"] },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "drama_order",
    rows.map((r) => r.id),
  );
  // profile 已实际持有 store130，端口锁本域160；账户420之前完成，显式目标员工独立于旧 store 列。
  return (
    await tx.dramaOrder.updateMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        OR: [{ deliveryManagerId: null }, { deliveryManagerId: { not: input.staffId } }],
      },
      data: { deliveryManagerId: input.staffId },
    })
  ).count;
};
export const registration = defineRegistration("order", {
  portImplementations: [
    implement(orderSidePort, {
      applyConfirmedPlan: (tx, input) => applyConfirmedPlan(tx, boundOrder(), input),
      rederive: (tx, input) => rederive(tx, boundOrder(), input),
    }),
    implementMerchantFacts("order", orderMerchantFacts),
    implement(orderManagerPort, syncOrderManager),
    implementKeyed(machinePort, chainKey("drama_order", "status"), {
      companions: ["sub_status", "status_changed_at", "closed_at"],
      activity: () => ({ category: "flow", action: "order.order.submit", summary: "确认订购短剧" }),
    }),
    implementKeyed(machinePort, chainKey("order_item", "phase"), {
      companions: ["phase_changed_at", "usage_start_date", "live_episode_count"],
      activity: () => ({
        category: "flow",
        action: "order.item.submit",
        summary: "冻结订单项积分",
      }),
      guards: {
        [rowKey("09:355", "package.pushed")]: async (_tx, facts) => isDerivationChecked(facts.args),
        [rowKey("09:356", "launch.changed")]: async (_tx, facts) => isDerivationChecked(facts.args),
        [rowKey("09:351", "order.submit")]: async (tx, facts) => {
          const item = await tx.orderItem.findUnique({
            where: { id: facts.subjectId },
            include: { pointHold: true, orderItemAccounts: true, dramaOrder: true },
          });
          return (
            item !== null &&
            item.phase === "pending_start" &&
            item.pointHold.status === "held" &&
            item.pointHold.refType === "order_item" &&
            item.pointHold.refId === item.id &&
            item.pointHold.qty === item.chargePoints &&
            item.entityId === item.dramaOrder.entityId &&
            item.storeId === item.dramaOrder.storeId &&
            item.orderItemAccounts.length > 0
          );
        },
      },
    }),
  ],
  invariants: [
    ...ORDER_INVARIANT_CODES.map((code) => ({
      code: `order.${code}`,
      severity: "P1" as const,
      modes: ["full" as const],
      heal: "none" as const,
      run: (
        tx: Parameters<typeof findOrderViolations>[0],
        scope: Parameters<typeof findOrderViolations>[2],
      ) => findOrderViolations(tx, code, scope),
    })),
    ...DERIVED_INVARIANT_CODES.map((code) => ({
      code: `order.${code}`,
      severity: "P2" as const,
      modes: ["full" as const],
      heal: code === "I1" ? ("none" as const) : ("heal_and_alert" as const),
      run: (
        tx: Parameters<typeof findDerivedViolations>[0],
        scope: Parameters<typeof findDerivedViolations>[2],
      ) => findDerivedViolations(tx, code, scope),
    })),
  ],
});
