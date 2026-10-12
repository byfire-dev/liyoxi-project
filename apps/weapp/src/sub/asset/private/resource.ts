import type { Me } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import type { AssetApi, AssetDetail, AssetFilters, AssetPage, AssetSummary, AssetTab } from "./api";

/** 包含同令牌下的角色／成员范围变化；仅内存比较，不落盘或上报。 */
export function assetScope(
  token: string | null,
  store: { currentStoreId: string | null; contextRev: number },
  me: Me | null,
): string | null {
  const membership = me?.memberships.find((item) =>
    item.stores.some((s) => s.storeId === store.currentStoreId),
  );
  if (!token || !store.currentStoreId || !membership || !me) return null;
  return JSON.stringify([
    token,
    store.currentStoreId,
    store.contextRev,
    me.user.merchantUserId,
    membership.memberId,
    membership.entity.entityId,
    membership.role,
    membership.stores.map((s) => [s.storeId, s.lifecycle]).sort(),
  ]);
}
export function assetError(error: unknown): string {
  if (error instanceof ApiError) {
    if (["NOT_A_MEMBER", "CAPABILITY_DENIED", "FORBIDDEN"].includes(error.error))
      return "门店权限已变化，请重新选择门店";
    if (error.error === "NOT_FOUND") return "素材不存在或已移除";
  }
  return "暂时无法加载素材，请重试";
}
export interface AssetState {
  filters: AssetFilters;
  tab: AssetTab;
  page: AssetPage | null;
  summary: AssetSummary | null;
  detail: AssetDetail | null;
  loading: boolean;
  summaryLoading: boolean;
  moreLoading: boolean;
  error: string | null;
  summaryError: string | null;
  moreError: string | null;
}
export function createAssetResource(deps: { api: AssetApi; scope(): string | null; id?: string }) {
  const scope = deps.scope();
  const listeners = new Set<() => void>();
  let alive = true,
    generation = 0;
  let state: AssetState = {
    filters: {},
    tab: "all",
    page: null,
    summary: null,
    detail: null,
    loading: false,
    summaryLoading: false,
    moreLoading: false,
    error: null,
    summaryError: null,
    moreError: null,
  };
  const current = () => alive && scope !== null && deps.scope() === scope;
  const publish = (patch: Partial<AssetState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const refresh = async (clear = false) => {
    if (!current()) return;
    const own = ++generation;
    const valid = () => own === generation && current();
    publish({
      loading: true,
      moreLoading: false,
      moreError: null,
      error: null,
      ...(clear ? { page: null, summary: null, detail: null } : {}),
    });
    if (deps.id) {
      try {
        const detail = await deps.api.detail(deps.id);
        if (valid()) publish({ detail });
      } catch (error) {
        if (valid()) publish({ detail: null, error: assetError(error) });
      } finally {
        if (valid()) publish({ loading: false });
      }
      return;
    }
    const { filters, tab } = state;
    publish({ summaryLoading: true, summaryError: null });
    await Promise.all([
      (async () => {
        try {
          const page = await deps.api.list(filters, tab);
          if (valid()) publish({ page });
        } catch (error) {
          if (valid()) publish({ page: null, error: assetError(error) });
        } finally {
          if (valid()) publish({ loading: false });
        }
      })(),
      (async () => {
        try {
          const summary = await deps.api.summary(filters);
          if (valid()) publish({ summary });
        } catch (error) {
          if (valid()) publish({ summary: null, summaryError: assetError(error) });
        } finally {
          if (valid()) publish({ summaryLoading: false });
        }
      })(),
    ]);
  };
  return {
    snapshot: () => state,
    current,
    suspend: () => {
      generation++;
      publish({
        page: null,
        summary: null,
        detail: null,
        loading: false,
        summaryLoading: false,
        moreLoading: false,
      });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    prepare: async (start: () => Promise<void>) => {
      const own = ++generation;
      await start().catch(() => undefined);
      if (current() && own === generation) await refresh();
    },
    change: async (filters: AssetFilters, tab = state.tab) => {
      if (!current()) return;
      const q = filters.q?.trim();
      publish({ filters: { ...filters, q: q || undefined }, tab });
      if (q && Array.from(q).length > 30) {
        generation++;
        publish({
          page: null,
          summary: null,
          loading: false,
          summaryLoading: false,
          moreLoading: false,
          error: "请输入1–30字搜索词",
        });
        return;
      }
      await refresh(true);
    },
    more: async () => {
      const page = state.page;
      if (!current() || state.loading || state.moreLoading || !page?.hasMore || !page.nextCursor)
        return;
      const own = generation;
      const valid = () => current() && own === generation;
      publish({ moreLoading: true, moreError: null });
      try {
        const next = await deps.api.list(state.filters, state.tab, page.nextCursor);
        if (valid()) {
          const ids = new Set(page.items.map((item) => item.storeAssetId));
          publish({
            page: {
              ...next,
              items: [
                ...page.items,
                ...next.items.filter(
                  (item) => !ids.has(item.storeAssetId) && !!ids.add(item.storeAssetId),
                ),
              ],
            },
          });
        }
      } catch (error) {
        if (valid()) publish({ moreError: assetError(error) });
      } finally {
        if (valid()) publish({ moreLoading: false });
      }
    },
    dispose: () => {
      alive = false;
      generation++;
      state = { ...state, page: null, summary: null, detail: null };
      listeners.clear();
    },
  };
}
