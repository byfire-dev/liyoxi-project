import type { DeliveryApi } from "../components/delivery-api";
import { mergeTaskPages } from "../../publish/components/merge-task-pages";
export async function readLaunchRecord(
  api: Pick<DeliveryApi, "tasks" | "task">,
  orderItemId: string,
  current: () => boolean,
) {
  let page = await api.tasks({ orderItemId, tab: "all", limit: 50 });
  const cursors = new Set<string>();
  while (current() && page.hasMore) {
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new Error("上线记录分页已变化，请刷新重试");
    cursors.add(page.nextCursor);
    page = mergeTaskPages(
      page,
      await api.tasks({ orderItemId, tab: "all", limit: 50, cursor: page.nextCursor }),
    );
  }
  if (!current()) return [];
  const ids = [
    ...new Set(
      page.items.flatMap((g) => g.items.flatMap((i) => i.tasks.map((t) => t.launchTaskId))),
    ),
  ];
  const details = await Promise.all(ids.map((id) => api.task(id)));
  return current() ? details : [];
}
export const patrolLabel = (status: string) =>
  status === "normal"
    ? "巡检正常"
    : status === "abnormal"
      ? "发现异常"
      : status === "recovered"
        ? "复查已恢复"
        : "巡检结果待确认";
