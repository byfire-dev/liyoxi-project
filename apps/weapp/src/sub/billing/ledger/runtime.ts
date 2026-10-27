import { account } from "@/lib/account-runtime";
import { request } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createLedgerApi } from "./api";
import { createLedgerModel, ledgerContext } from "./model";

export const currentLedgerContext = () => {
  const context = useContextStore.getState();
  return ledgerContext({
    token: useSessionStore.getState().accessToken,
    storeId: context.currentStoreId,
    contextRev: context.contextRev,
    me: account.snapshot().me,
  });
};
const ledgerShot = () => {
  if (process.env.TARO_ENV !== "h5") return undefined;
  const name = (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__;
  return name?.startsWith("ledger-") ? name : undefined;
};
export function ledgerModel() {
  let offline: Promise<typeof request> | undefined;
  const call: typeof request = async (path, options) => {
    const scene = ledgerShot();
    if (scene) {
      offline ??= import("../../../../shots/ledger-fixtures").then((m) =>
        m.offlineLedgerRequest(scene),
      );
      return (await offline)(path, options);
    }
    return request(path, options);
  };
  return createLedgerModel({
    api: createLedgerApi(call),
    prepare: () => account.start(),
    context: currentLedgerContext,
    // 固定离线样张的月份与虚构账目同源；生产仍取实际时刻并经公共北京时间函数转换。
    now: () => (ledgerShot() ? new Date("2026-10-18T00:00:00.000Z") : new Date()),
  });
}
