import type { DramaDetail, DramaPage, DramaQuery } from "@/stores/catalog";
import { mergeDramaPage } from "@/stores/catalog";
import type { TrailerApi } from "./api";

export const trailerShare = (detail: Pick<DramaDetail, "dramaId" | "title"> | null) =>
  detail
    ? {
        title: `《${detail.title}》｜狸有戏`,
        path: `/sub/catalog/detail/index?dramaId=${encodeURIComponent(detail.dramaId)}`,
      }
    : { title: "狸有戏短剧商城", path: "/pages/mall/index" };

interface FeedState {
  page: DramaPage | null;
  detail: DramaDetail | null;
  index: number;
  currentId: string | null;
  loading: boolean;
  nextLoading: boolean;
  error: string | null;
  nextError: string | null;
  needsRefresh: boolean;
}

/** 默认商城排序，每页20条；用户点下一部才读下一部详情，不扫描寻找可播剧。 */
export function createTrailerFeed(deps: {
  api: Pick<TrailerApi, "config" | "list" | "detail">;
  scope(): string;
  enabled(): boolean;
}) {
  const scope = deps.scope(),
    listeners = new Set<() => void>();
  let alive = true,
    hidden = false,
    generation = 0,
    sort: DramaQuery["sort"];
  const cursors = new Set<string>();
  let state: FeedState = {
    page: null,
    detail: null,
    index: -1,
    currentId: null,
    loading: false,
    nextLoading: false,
    error: null,
    nextError: null,
    needsRefresh: false,
  };
  const valid = () => alive && !hidden && deps.scope() === scope && deps.enabled();
  const update = (patch: Partial<FeedState>) => {
    if (!valid()) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const capture = () => {
    const own = generation;
    return () => valid() && own === generation;
  };
  async function select(id: string, index: number) {
    if (!valid()) return;
    generation++;
    const current = capture();
    update({ loading: true, detail: null, currentId: id, index, error: null, nextError: null });
    try {
      const detail = await deps.api.detail(id);
      if (current()) update({ detail });
    } catch (error) {
      if (current())
        update({ error: error instanceof Error ? error.message : "短剧详情加载失败，请重试" });
    } finally {
      if (current()) update({ loading: false });
    }
  }
  async function start(initialId?: string) {
    if (!valid()) return;
    generation++;
    const current = capture();
    cursors.clear();
    update({
      page: null,
      detail: null,
      currentId: null,
      index: -1,
      loading: true,
      nextLoading: false,
      error: null,
      nextError: null,
      needsRefresh: false,
    });
    try {
      const config = await deps.api.config();
      if (!current()) return;
      sort = config.defaultSort;
      const page = await deps.api.list({ sort, limit: 20 });
      if (!current()) return;
      update({ page, loading: false });
      const id = initialId || page.items[0]?.dramaId;
      if (id)
        await select(
          id,
          page.items.findIndex((item) => item.dramaId === id),
        );
    } catch (error) {
      if (current())
        update({
          loading: false,
          error: error instanceof Error ? error.message : "预告片列表加载失败，请重试",
        });
    }
  }
  async function next() {
    if (!valid() || state.loading || state.nextLoading || state.needsRefresh || !state.page) return;
    const nextIndex = state.index + 1,
      cached = state.page.items[nextIndex];
    if (cached) return select(cached.dramaId, nextIndex);
    if (!state.page.hasMore) return;
    const cursor = state.page.nextCursor;
    if (!cursor || cursors.has(cursor)) {
      update({ needsRefresh: true, nextError: "列表游标已失效，请刷新列表" });
      return;
    }
    const current = capture(),
      previous = state.page;
    update({ nextLoading: true, nextError: null });
    try {
      const page = await deps.api.list({ sort, limit: 20, cursor });
      if (!current()) return;
      const merged = mergeDramaPage(previous, page);
      if (page.viewerRole !== previous.viewerRole) {
        update({
          detail: null,
          page: null,
          needsRefresh: true,
          nextError: "浏览身份已变化，请刷新列表",
        });
        return;
      }
      cursors.add(cursor);
      if (merged.items.length <= previous.items.length) {
        update({ needsRefresh: true, nextError: "本页没有新的短剧，请刷新列表后重试" });
        return;
      }
      update({ page: merged, nextLoading: false });
      await select(merged.items[previous.items.length]!.dramaId, previous.items.length);
    } catch (error) {
      if (current())
        update({ nextError: error instanceof Error ? error.message : "下一页加载失败，请重试" });
    } finally {
      if (current()) update({ nextLoading: false });
    }
  }
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    next,
    retry: () => (state.currentId ? select(state.currentId, state.index) : start()),
    refresh: () => start(),
    capture,
    hide: () => {
      hidden = true;
      generation++;
      state = { ...state, loading: false, nextLoading: false };
    },
    show: () => {
      hidden = false;
    },
    dispose: () => {
      alive = false;
      generation++;
    },
  };
}
