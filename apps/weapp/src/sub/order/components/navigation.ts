import type { Data } from "@/lib/account-api";

const itemEntryRoutes: Record<string, string> = {
  "view-sample": "sub/order/sample/index",
  "confirm-sample": "sub/order/sample/index",
  "view-delivery": "sub/publish/downloads/index",
  "view-launch-record": "sub/order/launch-record/index",
};

export function deliveryItemEntries(item: Data<"m.order.get">["items"][number], owner: boolean) {
  if (!owner || !["producing", "to_launch", "live", "ended"].includes(item.phase)) return [];
  const done = (key: string) =>
    item.timeline.some((value) => value.key === key && value.state === "done");
  return [
    "view-sample",
    ...(done("delivered") ? ["view-delivery", "view-launch"] : []),
    ...(item.liveEpisodeCount > 0 || done("live") ? ["view-launch-record"] : []),
  ];
}

/** 多剧订单必须明确选择剧目，不能借第一项的 id 跳转。 */
export function deliveryEntry(order: Data<"m.order.get">, action: string, selectedId?: string) {
  if (action === "view-plan" || action === "confirm-plan") {
    return order.deliveryPlan
      ? `/sub/order/plan/index?deliveryPlanId=${encodeURIComponent(order.deliveryPlan.deliveryPlanId)}`
      : null;
  }
  if (action === "view-launch")
    return `/sub/publish/tasks/index?orderId=${encodeURIComponent(order.orderId)}`;
  const route = itemEntryRoutes[action];
  const item = selectedId
    ? order.items.find((value) => value.orderItemId === selectedId)
    : order.items.length === 1
      ? order.items[0]
      : null;
  return route && item ? `/${route}?orderItemId=${encodeURIComponent(item.orderItemId)}` : null;
}
