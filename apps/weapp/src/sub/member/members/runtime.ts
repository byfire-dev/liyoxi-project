import Taro from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { request } from "@/lib/runtime";
import { loginCode, storage } from "@/lib/platform.taro";
import { rememberFirstTouch } from "@/lib/account-source";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createTenantApi } from "./api";
import type { Me, TenantApi } from "./api";
import type { Attribution } from "@/lib/account-api";
export interface TenantRuntime {
  api: TenantApi;
  loginCode(): Promise<string>;
  attribution(): Attribution;
  selectResult(storeId: string, current: () => boolean, route?: string): Promise<void>;
}

export function tenantContext() {
  const s = useSessionStore.getState(),
    c = useContextStore.getState();
  const me = s.me as Me | null;
  return JSON.stringify([
    s.accessToken,
    c.currentStoreId,
    c.contextRev,
    me?.memberships.map((m) => [m.memberId, m.role, m.stores.map((v) => [v.storeId, v.lifecycle])]),
  ]);
}
export async function tenantRuntime(): Promise<TenantRuntime> {
  await account.start();
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_TENANT_SHOT__?: string }).__LYX_TENANT_SHOT__;
    if (scene) {
      const { offlineTenantRuntime } = await import("../../../../shots/tenant-fixtures");
      return offlineTenantRuntime(scene);
    }
  }
  return {
    api: createTenantApi(request),
    loginCode,
    attribution: () => rememberFirstTouch(storage),
    async selectResult(
      storeId: string,
      current: () => boolean,
      route = "sub/profile/profile/index",
    ) {
      if (!current()) return;
      const token = useSessionStore.getState().accessToken;
      const before = useContextStore.getState();
      await account.reloadMe(storeId);
      const expectedRev = before.contextRev + (before.currentStoreId === storeId ? 0 : 1);
      if (
        token !== useSessionStore.getState().accessToken ||
        useContextStore.getState().currentStoreId !== storeId ||
        useContextStore.getState().contextRev !== expectedRev
      )
        throw new Error("门店状态已变化，请重新选择门店");
      const selected = account
        .snapshot()
        .me?.memberships.flatMap((m) => m.stores)
        .find((s) => s.storeId === storeId);
      if (!selected) throw new Error("当前账号不能进入该门店");
      await account.switchStore(storeId, selected.name ?? "门店", "stores");
      if (
        token !== useSessionStore.getState().accessToken ||
        useContextStore.getState().currentStoreId !== storeId ||
        useContextStore.getState().contextRev !== expectedRev
      )
        return;
      await Taro.redirectTo({ url: `/${route}?storeId=${encodeURIComponent(storeId)}` });
    },
  };
}
export const tenantNavigate = (route: string) => Taro.navigateTo({ url: `/${route}` });
