import { useCallback, useEffect, useRef, useState } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { catalogScope, createCatalogLifetime, scopeKey, useCatalogStore } from "@/stores/catalog";
/** 本域小型取数适配；公共请求和账户恢复保持单份。 */
export function useCatalogResource<T>(load: () => Promise<T>, identity = "") {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  const version = useCatalogStore(
    (s) => s.revisions[useContextStore.getState().currentStoreId ?? "guest"] ?? 0,
  );
  const [refresh, reload] = useState(0),
    [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [life] = useState(createCatalogLifetime);
  const loadedRevision = useRef(-1),
    loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  useEffect(() => {
    life.mount();
    return () => life.dispose();
  }, [life]);
  const refreshNow = useCallback(() => {
    life.invalidate();
    reload((v) => v + 1);
  }, [life]);
  useEffect(() => {
    const current = life.read();
    useCatalogStore.getState().ensureScope(scopeKey(catalogScope()));
    void Promise.resolve()
      .then(() => {
        if (!current()) return;
        setLoading(true);
        setError(null);
        return account.start();
      })
      .then(async () => {
        if (!current()) return;
        const value = await loader.current();
        if (current()) {
          setData(value);
          loadedRevision.current =
            useCatalogStore.getState().revisions[catalogScope().storeId ?? "guest"] ?? 0;
        }
      })
      .catch((e: unknown) => {
        if (current()) setError(e instanceof Error ? e.message : "暂时无法加载，请重试");
      })
      .finally(() => {
        if (current()) {
          setLoading(false);
          void Taro.stopPullDownRefresh();
        }
      });
    return () => life.invalidate();
  }, [rev, token, refresh, identity, life]);
  useDidShow(() => {
    if (loadedRevision.current !== version) refreshNow();
  });
  usePullDownRefresh(refreshNow);
  return {
    data,
    error,
    loading,
    refresh: refreshNow,
    invalidate: life.invalidate,
    guard: life.capture,
  };
}
/** 原生标签栏角标只在本域标签页绑定；切店清空时立即撤旧角标。 */
export function useCatalogBadge() {
  const badge = useCatalogStore((s) => s.badge);
  useEffect(() => {
    if (badge !== null && badge > 0)
      void Taro.setTabBarBadge({ index: 2, text: badge > 99 ? "99+" : String(badge) });
    else void Taro.removeTabBarBadge({ index: 2 });
  }, [badge]);
}
