import { useCallback, useEffect, useRef, useState } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createPublishLifetime, usePublishStore } from "@/stores/publish";
export function usePublishResource<T>(load: () => Promise<T>) {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken),
    revision = usePublishStore((s) => s.revision);
  const [life] = useState(createPublishLifetime),
    [tick, reload] = useState(0),
    [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const loader = useRef(load),
    loaded = useRef(-1);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  useEffect(() => {
    life.mount();
    return life.dispose;
  }, [life]);
  const refresh = useCallback(() => {
    life.invalidate();
    reload((v) => v + 1);
  }, [life]);
  useEffect(() => {
    const current = life.read();
    usePublishStore.getState().ensureScope();
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
          loaded.current = usePublishStore.getState().revision;
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
  }, [rev, token, tick, life]);
  useDidShow(() => {
    if (loaded.current !== revision) refresh();
  });
  usePullDownRefresh(refresh);
  return { data, error, loading, refresh, guard: life.capture };
}
