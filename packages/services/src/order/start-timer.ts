import { paramsAt } from "../config/index.js";
import type { Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import type { OrderStartBinding } from "./start-binding.js";

/** 当前业务行已锁；正常待执行/已完成的同键不推迟，失败与跳过才复活。 */
export async function armOrderStart(
  tx: Tx,
  deps: OrderStartBinding,
  order: { id: string; entityId: string; storeId: string; submittedAt: Date },
) {
  const subject = { type: "drama_order", id: order.id },
    key = timerKey("order.start", subject),
    timer = await tx.timer.findFirst({ where: { dedupeKey: key, status: { not: "cancelled" } } });
  if (timer && ["scheduled", "dispatched", "fired"].includes(timer.status))
    return { id: timer.id, outcome: "unchanged" as const };
  const now = deps.clock.now(),
    params = await paramsAt(tx, ["order.start_delay_minutes"], now);
  return deps.timers.arm(tx, {
    kind: "order.start",
    subject,
    key,
    fireAt: new Date(
      Math.max(
        now.getTime(),
        order.submittedAt.getTime() + params["order.start_delay_minutes"] * 60_000,
      ),
    ),
    entityId: order.entityId,
    storeId: order.storeId,
  });
}
export async function updateStartSubStatus(tx: Tx, id: string, subStatus: string, now: Date) {
  return tx.dramaOrder.updateMany({
    where: { id, status: "pending_start", subStatus: { not: subStatus } },
    data: { subStatus, lockVersion: { increment: 1 }, updatedAt: now },
  });
}
