import { orderStatus, orderSubStatus, phaseFromTicket } from "@liyoxi/shared/aggregate";
import { calendarDate } from "@liyoxi/shared/time";
import { getTicketBriefByOrderItem } from "../delivery/index.js";
import type { OrderSide } from "../delivery/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { OrderBinding } from "./binding.js";

const pass = Symbol("order.derived");
export const derivationChecked = () => pass;
export const isDerivationChecked = (args: unknown) => args === pass;
type Input = Parameters<OrderSide["rederive"]>[1];
const date = (at: Date | null) => at?.toISOString().slice(0, 10) ?? null;
const ctx = () => createIdentityContext({ actor: { type: "system", job: "order.rederive" } });

/** 调用者已锁父160、项170（delivery回调时还持ticket180）；重入已有锁不新增逆序锁。 */
export async function rederive(tx: Tx, deps: OrderBinding, input: Input): Promise<void> {
  const ids = [...new Set(input.orderItemIds)].sort();
  if (!ids.length) return;
  // 无主体字段的 facts 只能属于本次单一 item，禁止复制事实到兄弟剧。
  if (input.launchFacts && ids.length !== 1) throw new AppError("VALIDATION_FAILED");
  const first = await tx.orderItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, dramaOrderId: true },
  });
  if (first.length !== ids.length) throw new AppError("NOT_FOUND");
  const orders = [...new Set(first.map((r) => r.dramaOrderId))].sort();
  await lockRows(tx, "drama_order", orders);
  await lockRows(tx, "order_item", ids);
  for (const id of ids) await deriveItem(tx, deps, id, input.launchFacts);
  for (const id of orders) await deriveOrder(tx, deps, id);
}

async function deriveItem(tx: Tx, deps: OrderBinding, id: string, facts: Input["launchFacts"]) {
  const item = await tx.orderItem.findUniqueOrThrow({ where: { id } });
  const ticket = await getTicketBriefByOrderItem(tx, id);
  if (!ticket) return;
  const target = phaseFromTicket(
    ticket.step,
    item.usageStartDate !== null,
    item.returnedPoints + item.convertedPoints,
  );
  let start = date(item.usageStartDate),
    count = item.liveEpisodeCount;
  if (facts) {
    const live = facts.accounts.filter((a) => a.isLive);
    const dates = live.flatMap((a) => (a.firstLaunchDate ? [a.firstLaunchDate] : [])).sort();
    const expectedCount = Math.max(0, ...live.map((a) => a.verifiedEpisodeCount));
    if (facts.hasLive !== live.length > 0 || facts.firstLaunchDate !== (dates[0] ?? null))
      throw new AppError("INTERNAL", { message: "上线事实不一致" });
    if (facts.hasLive && (!facts.firstLaunchDate || expectedCount < 1))
      throw new AppError("INTERNAL", { message: "已上线事实缺少首日或集数" });
    // 公共事实的 max 包含未live任务；只有真实上线账号的核验数可物化。
    count = expectedCount;
    if (!Number.isSafeInteger(count) || count < 0 || count > item.episodeCount)
      throw new AppError("INTERNAL", { message: "上线集数越界" });
    if (facts.hasLive) start = facts.firstLaunchDate;
  }
  if (target === "live" && !start)
    throw new AppError("INTERNAL", { message: "上线阶段缺少真实首日" });
  if (start && start > date(item.usageEndDate)!) throw new AppError("STATE_NOT_ALLOWED");
  const firstLive = item.usageStartDate === null && start !== null;
  const now = deps.clock.now();
  const set = {
    phase_changed_at: now,
    usage_start_date: start ? new Date(start) : null,
    live_episode_count: count,
  };
  let phase = item.phase;
  // 自愈也只能使用已登记的迁移；跨两步时两条真实状态历史，不能直接UPDATE。
  if (phase === "producing" && ["to_launch", "live"].includes(target)) {
    await deps.flow.transition(tx, ctx(), {
      machine: "order_item",
      stateField: "phase",
      id,
      event: "package.pushed",
      to: "to_launch",
      args: derivationChecked(),
      entityId: item.entityId,
      storeId: item.storeId,
      set: { phase_changed_at: now },
      emit: { none: true, primary: "package.delivered" },
    });
    phase = "to_launch";
  }
  if (phase !== target) {
    if (phase !== "to_launch" || target !== "live")
      throw new AppError("STATE_NOT_ALLOWED", { message: "当前迁移表不能纠正该订单项阶段" });
    await deps.flow.transition(tx, ctx(), {
      machine: "order_item",
      stateField: "phase",
      id,
      event: "launch.changed",
      to: "live",
      args: derivationChecked(),
      entityId: item.entityId,
      storeId: item.storeId,
      set,
      emit: firstLive
        ? {
            type: "order.item.went_live",
            payload: {
              v: 1,
              orderItemId: id,
              dramaOrderId: item.dramaOrderId,
              usageStartDate: start!,
            },
          }
        : { none: true, primary: "launch.verified" },
    });
  } else if (date(item.usageStartDate) !== start || item.liveEpisodeCount !== count) {
    if (firstLive) throw new AppError("INTERNAL", { message: "首次上线必须伴随阶段迁移" });
    await tx.orderItem.update({
      where: { id },
      data: {
        usageStartDate: start ? new Date(start) : null,
        liveEpisodeCount: count,
        lockVersion: { increment: 1 },
        updatedAt: now,
      },
    });
  }
}

export async function deriveOrder(
  tx: Tx,
  deps: OrderBinding,
  id: string,
  options: {
    closedCancelRequestId?: string;
    openedCancelRequestId?: string;
    suppressEvent?: boolean;
  } = {},
): Promise<void> {
  const o = await tx.dramaOrder.findUniqueOrThrow({
    where: { id },
    include: { orderItems: { orderBy: { id: "asc" } }, store: true, openCancelRequest: true },
  });
  if (options.closedCancelRequestId && o.openCancelRequestId !== options.closedCancelRequestId)
    throw new AppError("PRECONDITION_CHANGED");
  if (options.openedCancelRequestId && o.openCancelRequestId !== null)
    throw new AppError("ORDER_IN_AFTER_SALE", { details: { orderId: id } });
  const hasCancel =
    !!options.openedCancelRequestId ||
    (o.openCancelRequestId !== null && !options.closedCancelRequestId);
  const cancel = options.openedCancelRequestId
    ? await tx.cancelRequest.findUniqueOrThrow({ where: { id: options.openedCancelRequestId } })
    : o.openCancelRequest;
  const status = orderStatus(o.orderItems, hasCancel),
    today = calendarDate(deps.clock.now());
  const items = await Promise.all(
    o.orderItems.map(async (item) => {
      const ticket = await getTicketBriefByOrderItem(tx, item.id);
      return {
        phase: item.phase,
        ticketStep: ticket?.step,
        ...(ticket ? { launchState: ticket.launchState } : {}),
        ...(item.phase === "to_launch" && date(item.usageEndDate)! < today
          ? { launchState: "expired_unlaunched" as const }
          : {}),
        ...(item.phase === "live" && ticket?.step === "takedown"
          ? {
              liveState:
                date(item.usageEndDate)! < today
                  ? ("takedown_overdue" as const)
                  : ("takedown_pending" as const),
            }
          : {}),
      };
    }),
  );
  const subStatus = orderSubStatus({
    status,
    items,
    qualificationStatus: o.store.qualificationStatus,
    cancelRequestStatus: hasCancel ? cancel?.status : undefined,
  });
  if (status !== o.status) {
    const now = deps.clock.now();
    // pending_start→producing 归b的原子capture/start，a不得拿rederive冒充开工。
    await deps.flow.transition(tx, ctx(), {
      machine: "drama_order",
      stateField: "status",
      id,
      event: "order.rederive",
      to: status,
      ref:
        o.status === "after_sale"
          ? ["cancelled", "refunded"].includes(status)
            ? "09:201"
            : "09:200"
          : status === "after_sale"
            ? "09:199"
            : "09:198",
      entityId: o.entityId,
      storeId: o.storeId,
      set: {
        sub_status: subStatus,
        status_changed_at: now,
        closed_at: ["ended", "cancelled", "refunded"].includes(status) ? now : null,
        ...(options.closedCancelRequestId ? { open_cancel_request_id: null } : {}),
        ...(options.openedCancelRequestId
          ? { open_cancel_request_id: options.openedCancelRequestId }
          : {}),
      },
      emit: options.suppressEvent
        ? { none: true, primary: "cancel.executed" }
        : { type: "order.status_changed", payload: { v: 1, dramaOrderId: id } },
    });
  } else if (subStatus !== o.subStatus) {
    await tx.dramaOrder.update({
      where: { id },
      data: { subStatus, lockVersion: { increment: 1 }, updatedAt: deps.clock.now() },
    });
  }
}
