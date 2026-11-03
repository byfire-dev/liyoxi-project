import type { Body, Data } from "@/lib/account-api";
import type { createTaskWriteApi } from "./api";
export type LifecycleApi = ReturnType<typeof createTaskWriteApi>;
export type TakedownCard = Data<"m.takedownTask.list">["items"][number];
export type TakedownPage = Data<"m.takedownTask.list">;
export type Method = Body<"m.takedownTask.confirm">["method"];
export type TaskTab = "todo" | "done" | "all";
export type TakedownTab = "pending" | "done";
export type TakedownPart = { page: TakedownPage | null; error: string | null; cursors: string[] };
export type TakedownState = {
  pending: TakedownPart;
  done: TakedownPart;
  summary: Data<"m.takedownTask.summary"> | null;
  summaryError: string | null;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "下架任务读取失败，请重试";
export async function readTakedowns(
  api: Pick<LifecycleApi, "takedowns" | "takedownSummary">,
  tab: TaskTab,
  orderId?: string,
  targetId?: string,
  current: () => boolean = () => true,
): Promise<TakedownState> {
  const load = async (kind: TakedownTab): Promise<TakedownPart> => {
    if (tab !== "all" && (tab === "todo" ? kind !== "pending" : kind !== "done"))
      return { page: null, error: null, cursors: [] };
    try {
      let page = await api.takedowns({ tab: kind, orderId, limit: 20 });
      const cursors: string[] = [];
      while (
        current() &&
        targetId &&
        !page.items.some((item) => item.takedownTaskId === targetId) &&
        page.hasMore
      ) {
        if (!page.nextCursor || cursors.includes(page.nextCursor))
          throw new Error("下架分页已变化，请刷新任务");
        cursors.push(page.nextCursor);
        page = mergeTakedownPages(
          page,
          await api.takedowns({ tab: kind, orderId, limit: 20, cursor: page.nextCursor }),
        );
      }
      return { page, error: null, cursors };
    } catch (error) {
      return { page: null, error: message(error), cursors: [] };
    }
  };
  const [pending, done, summary] = await Promise.all([
    load("pending"),
    load("done"),
    api
      .takedownSummary(orderId)
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: null, error: message(error) })),
  ]);
  return { pending, done, summary: summary.value, summaryError: summary.error };
}
export function mergeTakedownPages(previous: TakedownPage, next: TakedownPage): TakedownPage {
  const byId = new Map(previous.items.map((item) => [item.takedownTaskId, item]));
  next.items.forEach((item) => byId.set(item.takedownTaskId, item));
  return { ...next, items: [...byId.values()] };
}
export async function moreTakedowns(
  api: Pick<LifecycleApi, "takedowns">,
  part: TakedownPart,
  tab: TakedownTab,
  orderId?: string,
): Promise<TakedownPart> {
  const page = part.page;
  if (!page?.hasMore) return part;
  if (!page.nextCursor || part.cursors.includes(page.nextCursor))
    return { ...part, error: "下架分页已变化，请刷新任务" };
  try {
    const next = await api.takedowns({ tab, orderId, limit: 20, cursor: page.nextCursor });
    return {
      page: mergeTakedownPages(page, next),
      error: null,
      cursors: [...part.cursors, page.nextCursor],
    };
  } catch (error) {
    return { ...part, error: message(error) };
  }
}
export const methodLabels: Readonly<Record<Method, string>> = {
  delete: "已删除作品",
  private: "已设为仅自己可见",
  not_published: "从未发布",
};
export function takedownBody(
  card: Pick<TakedownCard, "actions" | "allowedMethods" | "basis">,
  method: Method | null,
): Body<"m.takedownTask.confirm"> | null {
  return method &&
    card.actions.includes("confirm") &&
    card.allowedMethods.includes(method) &&
    (method !== "not_published" || card.basis === "delivered_unverified")
    ? { method }
    : null;
}
export function takedownItems(state: TakedownState | null) {
  const items = [...(state?.pending.page?.items ?? []), ...(state?.done.page?.items ?? [])];
  return [...new Map(items.map((item) => [item.takedownTaskId, item])).values()];
}
export function visibleTakedowns(state: TakedownState | null, tab: TakedownTab) {
  const items = state?.[tab].page?.items ?? [];
  if (tab === "done") return items;
  const doneIds = new Set(state?.done.page?.items.map((item) => item.takedownTaskId));
  return items.filter((item) => !doneIds.has(item.takedownTaskId));
}
export async function copyPublishList(
  api: Pick<LifecycleApi, "publishList">,
  id: string,
  current: () => boolean,
  copy: (text: string) => Promise<unknown>,
) {
  const value = await api.publishList(id);
  if (!current()) return false;
  if (!value.text?.trim()) throw new Error("发布清单暂无可复制文本，请联系服务经理");
  await copy(value.text);
  return current();
}

export const takedownStatusLabel = (status: string) =>
  status === "pending_merchant"
    ? "待商家处理"
    : status === "merchant_confirmed"
      ? "商家已确认，待后台核查"
      : status === "checked"
        ? "已核查"
        : "状态待确认";
