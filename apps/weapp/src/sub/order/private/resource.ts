import { useCallback, useEffect, useRef, useState } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createOrderLifetime, useOrderStore } from "@/stores/order";
export function useOrderResource<T>(
  load: () => Promise<T>,
  identity = "",
  mayRefresh = () => true,
) {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken),
    revision = useOrderStore((s) => s.revision);
  const [life] = useState(createOrderLifetime),
    [tick, reload] = useState(0),
    [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const loader = useRef(load),
    loaded = useRef(-1),
    refreshAllowed = useRef(mayRefresh);
  useEffect(() => {
    loader.current = load;
    refreshAllowed.current = mayRefresh;
  }, [load, mayRefresh]);
  useEffect(() => {
    life.mount();
    return life.dispose;
  }, [life]);
  const refresh = useCallback(() => {
    if (!refreshAllowed.current()) {
      void Taro.stopPullDownRefresh();
      return;
    }
    life.invalidate();
    reload((v) => v + 1);
  }, [life]);
  useEffect(() => {
    const current = life.read();
    useOrderStore.getState().ensureScope();
    void Promise.resolve()
      .then(() => {
        if (!current()) return;
        setLoading(true);
        setError(null);
        return account.start();
      })
      .then(() => (current() ? loader.current() : undefined))
      .then((value) => {
        if (current() && value !== undefined) {
          setData(value);
          loaded.current = useOrderStore.getState().revision;
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
    return life.invalidate;
  }, [identity, rev, token, tick, life]);
  useDidShow(() => {
    if (loaded.current !== revision) refresh();
  });
  usePullDownRefresh(refresh);
  return { data, error, loading, refresh, guard: life.capture, invalidate: life.invalidate };
}
