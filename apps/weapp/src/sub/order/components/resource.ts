import { useEffect, useRef, useState } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import type { SubscribePoint } from "@liyoxi/contract/notify";
import { account } from "@/lib/account-runtime";
import { newIdempotencyKey, withSubscribe } from "@/lib/runtime";
import { createDeliveryGuard, deliveryScope, deliveryScopeKey } from "@/stores/delivery";
import { deliveryError } from "./model";
export function useDeliveryResource<T>(load: (current: () => boolean) => Promise<T>) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [life] = useState(() => createDeliveryGuard(deliveryScopeKey, newIdempotencyKey));
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  useEffect(() => {
    life.mount();
    return () => life.dispose();
  }, [life]);
  const refresh = () => {
    life.invalidate();
    setRevision((v) => v + 1);
  };
  usePullDownRefresh(refresh);
  useEffect(() => {
    const current = life.nextRead();
    void Promise.resolve()
      .then(() => {
        if (!current()) return;
        setLoading(true);
        setError(null);
        setData(null);
        return account.start();
      })
      .then(async () => {
        if (!current()) return;
        if (deliveryScope().role !== "owner") throw new Error("仅老板可查看，请切换到老板门店");
        const value = await loader.current(current);
        if (current()) setData(value);
      })
      .catch((e) => {
        if (current()) setError(deliveryError(e));
      })
      .finally(() => {
        if (current()) {
          setLoading(false);
          void Taro.stopPullDownRefresh();
        }
      });
    return () => life.invalidate();
  }, [revision, life]);
  /** 同步锁先于订阅；授权期间、请求途中都检验上下文。 */
  const run = (point: SubscribePoint | null, action: (current: () => boolean) => Promise<void>) => {
    const current = life.begin();
    if (!current) return;
    setBusy(true);
    setError(null);
    const handler = async () => {
      try {
        if (current() && deliveryScope().role === "owner") await action(current);
      } catch (e) {
        if (current()) {
          setError(deliveryError(e));
          if ((e as { error?: string })?.error?.endsWith("VERSION_STALE")) {
            void Taro.showToast({ title: deliveryError(e), icon: "none" });
            refresh();
          }
        }
      } finally {
        if (life.finish(current)) setBusy(false);
      }
    };
    if (point) withSubscribe(point, handler)();
    else void handler();
  };
  return {
    data,
    error,
    loading,
    busy,
    refresh,
    run,
    intent: life.intent,
    replace: (value: T, current: () => boolean) => {
      if (current()) setData(value);
    },
  };
}
