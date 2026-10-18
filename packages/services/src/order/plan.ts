import { PlanContentSchema } from "@liyoxi/contract";
import type { OrderSide } from "../delivery/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { OrderBinding } from "./binding.js";
import { earliestLaunch, invalid } from "./checks.js";

/** delivery已锁父/项/账号190/方案200；这里只重入既有父项锁，不能首次逆序锁账号。 */
export async function applyConfirmedPlan(
  tx: Tx,
  deps: OrderBinding,
  input: Parameters<OrderSide["applyConfirmedPlan"]>[1],
): Promise<void> {
  const p = await tx.deliveryPlan.findFirst({
    where: { id: input.deliveryPlanId, dramaOrderId: input.dramaOrderId },
    include: {
      dramaOrder: { include: { orderItems: { include: { orderItemAccounts: true } } } },
      deliveryPlanVersions: true,
    },
  });
  if (!p) throw new AppError("NOT_FOUND");
  const o = p.dramaOrder;
  if (
    (input.ctx.entityId && input.ctx.entityId !== o.entityId) ||
    (input.ctx.storeId && input.ctx.storeId !== o.storeId)
  )
    throw new AppError("NOT_FOUND");
  await lockRows(tx, "drama_order", [o.id]);
  await lockRows(
    tx,
    "order_item",
    o.orderItems.map((r) => r.id),
  );
  if (o.openCancelRequestId)
    throw new AppError("ORDER_IN_AFTER_SALE", {
      details: { cancelRequestId: o.openCancelRequestId },
    });
  if (p.currentVersionNo !== input.versionNo)
    throw new AppError("PLAN_VERSION_STALE", { details: { currentVersionNo: p.currentVersionNo } });
  const v = p.deliveryPlanVersions.find((r) => r.versionNo === input.versionNo);
  if (p.status !== "pending_confirm" || !v || v.decision !== null)
    throw new AppError("STATE_NOT_ALLOWED");
  const content = PlanContentSchema.parse(input.content);
  if (JSON.stringify(content) !== JSON.stringify(PlanContentSchema.parse(v.contentSnapshot)))
    throw new AppError("STATE_NOT_ALLOWED");
  const active = o.orderItems.filter(
    (r) => !["cancelled", "refunded", "terminated"].includes(r.phase),
  );
  if (
    content.items.length !== active.length ||
    new Set(content.items.map((r) => r.orderItemId)).size !== active.length ||
    content.items.some((r) => !active.some((i) => i.id === r.orderItemId))
  )
    throw new AppError("NOT_FOUND");
  const min = await earliestLaunch(tx, deps, o.submittedAt),
    now = deps.clock.now();
  // 全部校验在业务写之前；已确认的版本事实不再重验购买资格/账号状态（m05 §3.6）。
  for (const row of content.items) {
    const item = active.find((r) => r.id === row.orderItemId)!;
    if (!row.agreedLaunchDate) invalid("content.items.agreedLaunchDate", "约定上线日不能为空");
    const max = item.usageEndDate.toISOString().slice(0, 10);
    if (row.agreedLaunchDate < min || row.agreedLaunchDate > max)
      throw new AppError("LAUNCH_DATE_OUT_OF_RANGE", {
        details: { orderItemId: item.id, minDate: min, maxDate: max },
      });
    const ids = row.accounts.map((a) => a.channelAccountId);
    const accounts = await tx.channelAccount.findMany({
      where: { id: { in: ids }, entityId: o.entityId, storeId: o.storeId },
    });
    if (
      !ids.length ||
      accounts.length !== ids.length ||
      new Set(row.accounts.map((a) => a.platform)).size !== ids.length ||
      row.accounts.some(
        (a) => accounts.find((r) => r.id === a.channelAccountId)?.platform !== a.platform,
      )
    )
      throw new AppError("ORDER_ACCOUNT_INVALID");
  }
  for (const row of content.items) {
    const item = active.find((r) => r.id === row.orderItemId)!;
    if (item.agreedLaunchDate?.toISOString().slice(0, 10) !== row.agreedLaunchDate)
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          agreedLaunchDate: new Date(row.agreedLaunchDate!),
          lockVersion: { increment: 1 },
          updatedAt: now,
        },
      });
    const next = new Set(row.accounts.map((a) => a.channelAccountId));
    await tx.orderItemAccount.deleteMany({
      where: { orderItemId: item.id, channelAccountId: { notIn: [...next] } },
    });
    const old = new Set(item.orderItemAccounts.map((a) => a.channelAccountId));
    for (const a of row.accounts)
      if (!old.has(a.channelAccountId))
        await tx.orderItemAccount.create({
          data: {
            orderItemId: item.id,
            channelAccountId: a.channelAccountId,
            platform: a.platform,
            createdAt: now,
          },
        });
  }
  // 广告位/参考素材不是M1本域写侧；不删除或重建兄弟域引用与已钉住快照。
}
