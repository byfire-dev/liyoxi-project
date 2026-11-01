import type { createMyDramasApi, DramaPage, DramaSummary, DramaTab } from "./api";
export const DRAMA_TABS: readonly { key: DramaTab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "live", label: "上线中" },
  { key: "to_launch", label: "待上线" },
  { key: "ended", label: "已结束" },
];
export function mergeItems(previous: DramaPage, next: DramaPage): DramaPage {
  const seen = new Set(previous.items.map((item) => item.orderItemId));
  return {
    ...next,
    items: [
      ...previous.items,
      ...next.items.filter(
        (item) => !seen.has(item.orderItemId) && Boolean(seen.add(item.orderItemId)),
      ),
    ],
  };
}
interface State {
  tab: DramaTab;
  page: DramaPage | null;
  summary: DramaSummary | null;
  loading: boolean;
  paging: boolean;
  error: string | null;
}
/** Only server item rows/counts. Every async continuation belongs to one owner scope/read. */
export function createMyDramasModel(deps: {
  api: ReturnType<typeof createMyDramasApi>;
  scope(): string;
  allowed(): boolean;
}) {
  let state: State = {
    tab: "all",
    page: null,
    summary: null,
    loading: false,
    paging: false,
    error: null,
  };
  let live = true,
    revision = 0;
  const listeners = new Set<() => void>(),
    cursors = new Set<string>();
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const capture = () => {
    const scope = deps.scope(),
      own = revision;
    return () => live && revision === own && scope === deps.scope() && deps.allowed();
  };
  const refresh = async (tab = state.tab) => {
    if (!live) return;
    revision++;
    cursors.clear();
    set({ tab, page: null, summary: null, error: null, loading: deps.allowed(), paging: false });
    if (!live || !deps.allowed()) return;
    const current = capture();
    try {
      const [page, summary] = await Promise.all([deps.api.list(tab), deps.api.summary()]);
      if (current())
        set({ page: mergeItems({ items: [], hasMore: false, nextCursor: null }, page), summary });
    } catch (error) {
      if (current())
        set({ error: error instanceof Error ? error.message : "暂时无法加载，请重试" });
    } finally {
      if (current()) set({ loading: false });
    }
  };
  const more = async () => {
    const page = state.page,
      cursor = page?.nextCursor;
    if (!live || !deps.allowed() || state.loading || state.paging || !page?.hasMore || !cursor)
      return;
    if (cursors.has(cursor)) {
      set({ error: "分页游标已失效，请下拉刷新" });
      return;
    }
    const current = capture();
    set({ paging: true, error: null });
    try {
      const next = await deps.api.list(state.tab, cursor);
      if (current()) {
        cursors.add(cursor);
        set({ page: mergeItems(page, next) });
      }
    } catch (error) {
      if (current()) set({ error: error instanceof Error ? error.message : "加载失败，请重试" });
    } finally {
      if (current()) set({ paging: false });
    }
  };
  return {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refresh,
    more,
    async openItem(id: string) {
      if (!live || !deps.allowed() || !state.page?.items.some((item) => item.orderItemId === id))
        return null;
      const current = capture();
      try {
        const item = await deps.api.get(id);
        return current() && item.orderItemId === id ? item.orderId : null;
      } catch (error) {
        if (current())
          set({ error: error instanceof Error ? error.message : "暂时无法查看，请重试" });
        return null;
      }
    },
    dispose: () => {
      live = false;
      revision++;
      listeners.clear();
    },
    mount: () => {
      live = true;
    },
  };
}
