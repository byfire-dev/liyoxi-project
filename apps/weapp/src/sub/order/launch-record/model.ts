import type { DeliveryApi } from "../components/delivery-api";
import { mergeTaskPages } from "../../publish/components/merge-task-pages";
export async function readLaunchRecord(
  api: Pick<DeliveryApi, "tasks" | "task">,
  orderItemId: string,
  current: () => boolean,
) {
  let page = await api.tasks({ orderItemId, tab: "all", limit: 50 });
  const cursors = new Set<string>();
  while (current() && page.hasMore && page.nextCursor && !cursors.has(page.nextCursor)) {
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
  return Promise.all(ids.map((id) => api.task(id)));
}
