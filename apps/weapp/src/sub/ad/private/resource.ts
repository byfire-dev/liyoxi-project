import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { createDeliveryGuard, deliveryScope, deliveryScopeKey } from "@/stores/delivery";
import { newIdempotencyKey, withSubscribe } from "@/lib/runtime";
import type { SubscribePoint } from "@liyoxi/contract/notify";
import { adError } from "./model";

export const adOwner = () => Boolean(deliveryScope().token && deliveryScope().role === "owner");
export function useAdResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const [life] = useState(() => createDeliveryGuard(deliveryScopeKey, newIdempotencyKey));
  const loader = useRef(load),
    shown = useRef(false);
  useLayoutEffect(() => {
    loader.current = load;
  }, [load]);
  const refresh = useCallback(() => {
    life.invalidate();
    setTick((n) => n + 1);
  }, [life]);
  useEffect(() => {
    life.mount();
    return life.dispose;
  }, [life]);
  useEffect(() => {
    const current = life.nextRead();
    void Promise.resolve()
      .then(async () => {
        if (!current()) return;
        setLoading(true);
        setError(null);
        setData(null);
        await account.start();
        if (!current()) return;
        if (!adOwner()) throw new Error("仅老板可查看和管理广告");
        const value = await loader.current();
        if (current()) setData(value);
      })
      .catch((cause) => {
        if (current()) setError(adError(cause));
      })
      .finally(() => {
        if (current()) {
          setLoading(false);
          void Taro.stopPullDownRefresh();
        }
      });
    return life.invalidate;
  }, [tick, life]);
  useDidShow(() => {
    if (shown.current) refresh();
    shown.current = true;
  });
  usePullDownRefresh(refresh);
  const run = (action: (current: () => boolean) => Promise<void>, point?: SubscribePoint) => {
    const current = life.begin();
    if (!current || !adOwner()) return;
    setBusy(true);
    setError(null);
    const handler = async () => {
      try {
        if (current() && adOwner()) await action(() => current() && adOwner());
      } catch (cause) {
        if (current()) setError(adError(cause));
      } finally {
        if (life.finish(current)) setBusy(false);
      }
    };
    if (point) withSubscribe(point, handler)();
    else void handler();
  };
  return {
    data,
    loading,
    error,
    busy,
    refresh,
    run,
    intent: life.intent,
    capture: life.capture,
    replace: (value: T, current: () => boolean) => {
      if (current()) setData(value);
    },
  };
}
