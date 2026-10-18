import { createClientReporting } from "./client-reporting";
import { SUBSCRIBE_POINT_KEYS } from "@liyoxi/contract/notify";
import Taro from "@tarojs/taro";
import { useSyncExternalStore } from "react";

import { createAccountApi, type Data } from "./account-api";
import { createAccountController } from "./account-controller";
import { browseAsGuest, returnFromLogin } from "./account-routing";
import { accountLoginCode, rememberFirstTouch } from "./account-source";
import { systemClock } from "./platform";
import { loginCode, storage } from "./platform.taro";
import type { RequestLayer } from "./request";
import { newIdempotencyKey, request, startApp, track } from "./runtime";
import { connectServer } from "./server";
import { StorageKey } from "./storage";
import { useBootstrapStore, type BootstrapData } from "../stores/bootstrap";
import { useContextStore } from "../stores/context";
import { useSessionStore } from "../stores/session";

let offline = false;
let call: RequestLayer["request"] = request;
let ready: () => void;
const installed = new Promise<void>((resolve) => {
  ready = resolve;
});
const api = createAccountApi(async (path, options) => {
  await installed;
  return call(path, options);
});

export function bootstrapProjection(value: Data<"m.bootstrap.get">): Partial<BootstrapData> {
  return {
    serverTime: value.serverTime,
    minClientVersion: value.minClientVersion,
    flags: value.flags,
    subscribeCooldownDays: value.subscribeCooldownDays,
    subscribeMaxPerAsk: value.subscribeMaxPerAsk,
    subscribePlan:
      value.subscribePlan?.flatMap((item) => {
        const point = SUBSCRIBE_POINT_KEYS.find((key) => key === item.point);
        return point ? [{ point, slots: item.slots }] : [];
      }) ?? null,
    uploadLimits: value.uploadLimits,
    download: { weappSaveMode: value.download.weappSaveMode === "user_dir" ? "user_dir" : "temp" },
    copy: value.copy,
    context: value.context,
  };
}

export const account = createAccountController({
  api,
  clock: systemClock,
  token: () => useSessionStore.getState().accessToken,
  setSession: (token, me) => useSessionStore.getState().setSession(token, me),
  setMe: (me) => useSessionStore.getState().setMe(me),
  clearSession: () => useSessionStore.getState().clear(),
  store: () => useContextStore.getState(),
  setStore: (id) => useContextStore.getState().switchStore(id),
  loginCode: () =>
    offline ? Promise.resolve("local-offline-account") : accountLoginCode(loginCode),
  attribution: () => rememberFirstTouch(storage),
  key: () => newIdempotencyKey("store_switch"),
  applyBootstrap: (value) =>
    useBootstrapStore.getState().apply(bootstrapProjection(value), systemClock.now()),
  returnPage: returnFromLogin,
  guestHome: browseAsGuest,
  toast: (title) => {
    void Taro.showToast({ title, icon: "none" });
  },
  track: (name, props) => {
    if (name === "app_launch")
      track(name, { channelCode: props.channelCode, hasInvitation: props.hasInvitation ?? false });
    else track(name, { fromPage: props.fromPage ?? "mine" });
  },
});
// 中央请求恢复清空令牌时，同时废弃本包在途响应与个人视图。
useSessionStore.subscribe((state, previous) => {
  if (previous.accessToken && !state.accessToken) account.clear();
});
export const useAccount = () =>
  useSyncExternalStore(account.subscribe, account.snapshot, account.snapshot);

/** 离线样张只在 H5 的显式注入场景启用；小程序生产始终使用中央 request。 */
export async function launchAccount(options?: {
  scene?: number;
  query?: Record<string, unknown>;
}): Promise<void> {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_ACCOUNT_SHOT__?: string }).__LYX_ACCOUNT_SHOT__;
    if (scene) {
      const { offlineAccountRequest } = await import("../../shots/account-fixtures");
      call = offlineAccountRequest(scene);
      offline = true;
      storage.remove(StorageKey.accessToken);
      storage.remove(StorageKey.currentStoreId);
    }
  }
  rememberFirstTouch(storage, options);
  connectServer({
    ...createClientReporting((path, options) => call(path, options)),
    fetchBootstrap: async () => bootstrapProjection(await account.bootstrap()),
    silentLogin: account.silentLogin,
    reloadMe: account.reloadMe,
    askConsent: account.askConsent,
    showUpdatePrompt: async () => {
      const manager = Taro.getUpdateManager?.();
      if (manager)
        manager.onUpdateReady(() => {
          void Taro.showModal({
            title: "版本更新",
            content: "新版本已准备好，重新打开即可使用",
            success: (result) => {
              if (result.confirm) manager.applyUpdate();
            },
          });
        });
      else
        await Taro.showModal({
          title: "版本更新",
          content: "请关闭后重新打开，使用最新版本",
          showCancel: false,
        });
    },
  });
  ready();
  startApp(options);
  await account.start();
}
