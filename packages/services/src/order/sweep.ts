import { alertsOf, lockRows } from "../kernel/index.js";
import type { RecurringRunContext, Tx } from "../kernel/index.js";
import { storeGate } from "../profile/index.js";
import { timerKey } from "../timers/index.js";
import { boundOrderStart } from "./start-binding.js";
import type { OrderStartBinding } from "./start-binding.js";
import { armOrderStart, updateStartSubStatus } from "./start-timer.js";

export async function sweepPendingStarts(tx: Tx, deps: OrderStartBinding) {
  const rows = await tx.dramaOrder.findMany({
    where: {
      status: "pending_start",
      openCancelRequestId: null,
      store: {
        lifecycle: "active",
        qualificationStatus: "verified",
        entity: { lifecycle: "active" },
      },
    },
    orderBy: { id: "asc" },
  });
  // 与资质决定保持同一锁序；这里只登记，绝不在扫描事务里扣减开工。
  await lockRows(
    tx,
    "store",
    rows.map((o) => o.storeId),
  );
  await lockRows(
    tx,
    "drama_order",
    rows.map((o) => o.id),
  );
  let repaired = 0;
  for (const before of rows) {
    const order = await tx.dramaOrder.findUniqueOrThrow({ where: { id: before.id } });
    if (
      order.status !== "pending_start" ||
      order.openCancelRequestId ||
      (await storeGate(tx, order.storeId)) !== "full"
    )
      continue;
    const key = timerKey("order.start", { type: "drama_order", id: order.id });
    if (
      await tx.timer.count({
        where: { dedupeKey: key, status: { in: ["scheduled", "dispatched"] } },
      })
    )
      continue;
    const armed = await armOrderStart(tx, deps, order);
    await updateStartSubStatus(tx, order.id, "starting", deps.clock.now());
    if (armed.outcome !== "unchanged") repaired++;
    await alertsOf(deps.assembly).raise({
      rule: "order.pending_start_missing",
      dimension: order.id,
      severity: "P3",
      detail: { dramaOrderId: order.id, timerId: armed.id, outcome: armed.outcome },
    });
  }
  return { repaired };
}
export async function runPendingStartSweep(ctx: RecurringRunContext) {
  if (!ctx.tx) throw new TypeError("order.pending_start_sweep 必须在 tx 模式运行");
  return sweepPendingStarts(ctx.tx, boundOrderStart());
}
