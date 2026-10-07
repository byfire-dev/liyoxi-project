import type { TaskPage } from "../../order/components/delivery-api";
/** 翻页按任务 id 合并，订单与订单项的服务端聚合保持完整。 */
export function mergeTaskPages(previous: TaskPage, next: TaskPage): TaskPage {
  const groups = previous.items.map((g) => ({
    ...g,
    items: g.items.map((i) => ({ ...i, tasks: [...i.tasks] })),
  }));
  for (const group of next.items) {
    const target = groups.find((g) => g.orderId === group.orderId);
    if (!target) {
      groups.push(group);
      continue;
    }
    for (const item of group.items) {
      const old = target.items.find((i) => i.orderItemId === item.orderItemId);
      if (!old) {
        target.items.push(item);
        continue;
      }
      const byId = new Map(old.tasks.map((t) => [t.launchTaskId, t]));
      item.tasks.forEach((t) => byId.set(t.launchTaskId, t));
      Object.assign(old, item, { tasks: [...byId.values()] });
    }
  }
  return { ...next, items: groups };
}
