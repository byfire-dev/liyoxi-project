import type { Me } from "@/lib/account-api";
import type { AssetFilters, AssetSummary } from "./api";
import type { DemandPage } from "./upload-api";
import type { HomeAssetsApi } from "./home-assets-api";
import { assetError, assetScope } from "./resource";

export function homeAssetsScope(
  token: string | null,
  store: { currentStoreId: string | null; contextRev: number },
  me: Me | null,
): string | null {
  const member = me?.memberships.find((m) =>
    m.stores.some((s) => s.storeId === store.currentStoreId),
  );
  return member && (member.role === "owner" || member.role === "clerk")
    ? assetScope(token, store, me)
    : null;
}
export const homeAssetLibraryUrl = (adopted = false) =>
  `/sub/asset/lib/index?uploader=me${adopted ? "&status=adopted" : ""}`;
export const homeAssetUploadUrl = (id?: string) =>
  `/sub/asset/upload/index${id ? `?assetDemandId=${encodeURIComponent(id)}` : ""}`;
/** 路由仅选择已有筛选，不接受任意筛选对象或自造需求。 */
export function homeAssetLibraryEntry(params: Record<string, string | undefined>): AssetFilters {
  return {
    ...(params.uploader === "me" ? { uploader: "me" as const } : {}),
    ...(params.status === "adopted" ? { status: "adopted" } : {}),
  };
}
export function homeAssetDemandEntry(value: string | undefined, page: DemandPage): string | null {
  return (
    page.items.find((item) => item.assetDemandId === value && item.status === "open")
      ?.assetDemandId ?? null
  );
}
export interface HomeAssetsState {
  demands: DemandPage | null;
  summary: AssetSummary | null;
  demandsLoading: boolean;
  summaryLoading: boolean;
  demandsError: string | null;
  summaryError: string | null;
}
export function createHomeAssetsResource(deps: { api: HomeAssetsApi; scope(): string | null }) {
  const scope = deps.scope(),
    listeners = new Set<() => void>();
  let active = true,
    generation = 0;
  const blank = (): HomeAssetsState => ({
    demands: null,
    summary: null,
    demandsLoading: false,
    summaryLoading: false,
    demandsError: null,
    summaryError: null,
  });
  let state = blank();
  const current = () => active && scope !== null && deps.scope() === scope;
  const publish = (patch: Partial<HomeAssetsState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const refresh = async () => {
    if (!current()) return;
    const own = ++generation,
      valid = () => current() && generation === own;
    publish({ ...blank(), demandsLoading: true, summaryLoading: true });
    await Promise.all([
      (async () => {
        try {
          const demands = await deps.api.demands();
          if (valid()) publish({ demands });
        } catch (error) {
          if (valid()) publish({ demandsError: assetError(error) });
        } finally {
          if (valid()) publish({ demandsLoading: false });
        }
      })(),
      (async () => {
        try {
          const summary = await deps.api.summary();
          if (valid()) publish({ summary });
        } catch (error) {
          if (valid()) publish({ summaryError: assetError(error) });
        } finally {
          if (valid()) publish({ summaryLoading: false });
        }
      })(),
    ]);
  };
  const suspend = () => {
    generation++;
    state = blank();
    active = false;
    listeners.forEach((listener) => listener());
  };
  return {
    snapshot: () => state,
    current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    prepare: async (start: () => Promise<void>) => {
      if (!current()) return;
      const own = ++generation;
      await start().catch(() => undefined);
      if (current() && own === generation) await refresh();
    },
    resume: () => {
      active = true;
    },
    suspend,
    dispose: () => {
      suspend();
      listeners.clear();
    },
  };
}
