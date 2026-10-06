import Taro from "@tarojs/taro";

import { returnTarget, type ReturnPage } from "./account-navigation";
import { gotoLogin, storage } from "./platform.taro";
import { StorageKey } from "./storage";

export function gotoAccountLogin(): void {
  const page = Taro.getCurrentPages().at(-1);
  if (page && page.route !== "pages/login/index") {
    storage.set(StorageKey.loginReturn, { route: page.route, query: page.options });
  }
  gotoLogin();
}

export async function returnFromLogin(): Promise<void> {
  const target = returnTarget(storage.get<ReturnPage>(StorageKey.loginReturn));
  storage.remove(StorageKey.loginReturn);
  if (target.tab) await Taro.switchTab({ url: target.url });
  else await Taro.reLaunch({ url: target.url });
}

export async function browseAsGuest(): Promise<void> {
  storage.remove(StorageKey.loginReturn);
  await Taro.switchTab({ url: "/pages/home/index" });
}
