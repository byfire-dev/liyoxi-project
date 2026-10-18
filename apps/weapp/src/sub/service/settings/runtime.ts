import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { gotoAccountLogin } from "@/lib/account-routing";
import { newIdempotencyKey, request } from "@/lib/runtime";
import { useSessionStore } from "@/stores/session";
import { useContextStore } from "@/stores/context";
import type { RequestLayer } from "@/lib/request";
import { systemClock } from "@/lib/platform";
import { createSettingsApi } from "./api";
import { createSettingsController } from "./model";

export const settingsScope = () =>
  JSON.stringify([useSessionStore.getState().accessToken, useContextStore.getState().contextRev]);
let call: RequestLayer["request"] = request;
let installation: Promise<void> | null = null;
async function installShots() {
  if (process.env.TARO_ENV !== "h5") return;
  const scene = (globalThis as { __LYX_SETTINGS_SHOT__?: string }).__LYX_SETTINGS_SHOT__;
  if (scene) {
    installation ??= import("../../../../shots/settings-fixtures").then(
      ({ offlineSettingsRequest }) => {
        call = offlineSettingsRequest(scene);
      },
    );
    await installation;
  }
}
export const settingsApi = createSettingsApi(async (path, options) => {
  await installShots();
  return call(path, options);
});
export function useSettingsResource() {
  const token = useSessionStore((s) => s.accessToken),
    rev = useContextStore((s) => s.contextRev);
  const scope = JSON.stringify([token, rev]);
  const controller = useMemo(
    () =>
      createSettingsController({
        api: settingsApi,
        scope: settingsScope,
        initialScope: scope,
        authenticated: () => Boolean(useSessionStore.getState().accessToken),
        key: newIdempotencyKey,
        now: systemClock.now,
        clear: () => account.clear(),
        gotoLogin: gotoAccountLogin,
        logout: () => account.logout(),
        reloadMe: () => account.reloadMe(),
      }),
    [scope],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const load = useCallback(() => {
    void account
      .start()
      .then(() => controller.refresh())
      .catch(() => {});
  }, [controller]);
  useEffect(() => {
    load();
    return controller.dispose;
  }, [controller, load]);
  useDidShow(load);
  usePullDownRefresh(() => {
    void controller.refresh().finally(() => Taro.stopPullDownRefresh());
  });
  return { controller, state, token, scope: settingsScope() };
}
