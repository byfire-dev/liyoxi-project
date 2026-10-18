import type { Body } from "@/lib/account-api";
import type { OrderReferenceApi, ReferenceCard, ReferencePage } from "./reference-api";
export interface ReferenceState {
  page: ReferencePage | null;
  selected: ReferenceCard[];
  loading: boolean;
  moreLoading: boolean;
  error: string | null;
  moreError: string | null;
}
export function createOrderReferences(deps: {
  api: OrderReferenceApi;
  scope(): string | null;
  changed?(): void;
  ids?: readonly string[];
  locked?(): boolean;
}) {
  const owner = deps.scope(),
    listeners = new Set<() => void>();
  let alive = true,
    visible = true,
    generation = 0;
  let state: ReferenceState = {
    page: null,
    selected: [],
    loading: false,
    moreLoading: false,
    error: null,
    moreError: null,
  };
  const current = () => alive && visible && owner !== null && owner === deps.scope();
  const publish = (patch: Partial<ReferenceState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    listeners.forEach((run) => run());
  };
  const unique = (items: ReferenceCard[]) => [
    ...new Map(items.map((item) => [item.storeAssetId, item])).values(),
  ];
  const refresh = async () => {
    if (!current() || deps.locked?.()) return;
    const own = ++generation,
      valid = () => current() && own === generation;
    publish({ loading: true, moreLoading: false, error: null, moreError: null });
    try {
      const ids = deps.ids ?? state.selected.map((item) => item.storeAssetId);
      const [page, selected] = await Promise.all([
        deps.ids
          ? ids.length
            ? deps.api.byIds(ids)
            : Promise.resolve({ items: [], hasMore: false, nextCursor: null })
          : deps.api.list(),
        !deps.ids && ids.length ? deps.api.byIds(ids) : Promise.resolve(null),
      ]);
      if (!valid()) return;
      if (selected) {
        const byId = new Map(selected.items.map((item) => [item.storeAssetId, item]));
        const next = state.selected.map((old) => {
          const item = byId.get(old.storeAssetId);
          return item ?? { ...old, isSelectableAsReference: false };
        });
        publish({ selected: next });
      }
      publish({ page: { ...page, items: unique(page.items) } });
    } catch {
      if (valid())
        publish({ page: null, error: "参考素材暂时无法加载，请重试；也可不选素材继续订购" });
    } finally {
      if (valid()) publish({ loading: false });
    }
  };
  return {
    snapshot: () => state,
    current,
    refresh,
    subscribe(run: () => void) {
      listeners.add(run);
      return () => {
        listeners.delete(run);
      };
    },
    async more() {
      const page = state.page;
      if (
        !current() ||
        deps.locked?.() ||
        deps.ids ||
        state.loading ||
        state.moreLoading ||
        !page?.hasMore ||
        !page.nextCursor
      )
        return;
      const own = generation,
        valid = () => current() && own === generation;
      publish({ moreLoading: true, moreError: null });
      try {
        const next = await deps.api.list(page.nextCursor);
        if (valid()) publish({ page: { ...next, items: unique([...page.items, ...next.items]) } });
      } catch {
        if (valid()) publish({ moreError: "未能加载更多参考素材，请重试" });
      } finally {
        if (valid()) publish({ moreLoading: false });
      }
    },
    toggle(id: string) {
      if (!current() || deps.locked?.() || deps.ids || state.loading) return;
      const old = state.selected.find((item) => item.storeAssetId === id);
      if (old) publish({ selected: state.selected.filter((item) => item.storeAssetId !== id) });
      else {
        const item = state.page?.items.find((candidate) => candidate.storeAssetId === id);
        if (!item?.isSelectableAsReference || state.selected.length >= 9) return;
        publish({ selected: [...state.selected, item] });
      }
      deps.changed?.();
    },
    body(): Pick<Body<"m.order.create">, "referenceStoreAssetIds"> | null {
      if (!current()) return null;
      return state.selected.length
        ? { referenceStoreAssetIds: state.selected.map((item) => item.storeAssetId) }
        : {};
    },
    suspend() {
      visible = false;
      generation++;
    },
    resume() {
      if (!alive || owner !== deps.scope()) return;
      visible = true;
      void refresh();
    },
    dispose() {
      alive = false;
      generation++;
      listeners.clear();
    },
  };
}
export type OrderReferences = ReturnType<typeof createOrderReferences>;
