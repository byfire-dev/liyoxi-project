import { normalizeKeyword, validKeyword } from "../../../lib/search-history";
import type { SearchHistory } from "../../../lib/search-history";
import type { SearchApi, SearchConfig, SearchPage } from "./api";
import { mergeSearchPage, searchError } from "./model";

/** 页面自己的输入防抖默认值；不会改变服务器查询/缓存时间。 */
export const SEARCH_DEBOUNCE_MS = 300;
export interface SearchState {
  input: string;
  query: string;
  history: string[];
  config: SearchConfig | null;
  configLoading: boolean;
  configError: string | null;
  page: SearchPage | null;
  loading: boolean;
  error: string | null;
  moreLoading: boolean;
  moreError: string | null;
}
export function createSearchResource(deps: {
  api: SearchApi;
  history: SearchHistory;
  /** 既有 catalogScope 的内存 key，不持久化/上报。 */
  scope(): string;
  schedule?(run: () => void, delayMs: number): () => void;
}) {
  const initialScope = deps.scope();
  const listeners = new Set<() => void>();
  let alive = true,
    generation = 0,
    configGeneration = 0,
    cancel: (() => void) | null = null;
  let state: SearchState = {
    input: "",
    query: "",
    history: deps.history.read(),
    config: null,
    configLoading: false,
    configError: null,
    page: null,
    loading: false,
    error: null,
    moreLoading: false,
    moreError: null,
  };
  const current = () => alive && deps.scope() === initialScope;
  const update = (patch: Partial<SearchState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const stopTimer = () => {
    cancel?.();
    cancel = null;
  };
  const reset = (input: string) => {
    stopTimer();
    generation++;
    update({
      input,
      query: normalizeKeyword(input),
      page: null,
      error: null,
      loading: false,
      moreLoading: false,
      moreError: null,
    });
  };
  const schedule =
    deps.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
  const submit = async (input = state.input) => {
    if (!current()) return;
    reset(input);
    const q = normalizeKeyword(input);
    if (!q) return;
    if (!validKeyword(q)) {
      update({ error: "请输入1–20字搜索词" });
      return;
    }
    const own = generation;
    update({ history: deps.history.remember(q), loading: true });
    try {
      const page = await deps.api.search(q);
      if (own === generation) update({ page });
    } catch (error) {
      if (own === generation) update({ error: searchError(error) });
    } finally {
      if (own === generation) update({ loading: false });
    }
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit,
    change: (input: string) => {
      if (!current()) return;
      reset(input);
      if (!normalizeKeyword(input)) return;
      if (!validKeyword(input)) {
        update({ error: "请输入1–20字搜索词" });
        return;
      }
      update({ loading: true });
      cancel = schedule(() => {
        cancel = null;
        void submit(input);
      }, SEARCH_DEBOUNCE_MS);
    },
    clearHistory: () => {
      if (current()) {
        deps.history.clear();
        update({ history: [] });
      }
    },
    config: async () => {
      if (!current()) return;
      const own = ++configGeneration;
      update({ configLoading: true, configError: null });
      try {
        const config = await deps.api.config();
        if (own === configGeneration) update({ config });
      } catch (error) {
        if (own === configGeneration) update({ configError: searchError(error) });
      } finally {
        if (own === configGeneration) update({ configLoading: false });
      }
    },
    more: async () => {
      const page = state.page;
      if (!current() || state.loading || state.moreLoading || !page?.hasMore || !page.nextCursor)
        return;
      const own = generation;
      update({ moreLoading: true, moreError: null });
      try {
        const next = await deps.api.search(state.query, page.nextCursor);
        if (own === generation) update({ page: mergeSearchPage(page, next) });
      } catch (error) {
        if (own === generation) update({ moreError: searchError(error) });
      } finally {
        if (own === generation) update({ moreLoading: false });
      }
    },
    dispose: () => {
      alive = false;
      generation++;
      configGeneration++;
      stopTimer();
      listeners.clear();
    },
  };
}
