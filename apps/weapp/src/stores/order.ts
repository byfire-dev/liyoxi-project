import { create } from "zustand";
import type { Data } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import { catalogScope, createCatalogLifetime, scopeKey } from "./catalog";
export type OrderQuote = Data<"m.order.quote">;
export type OrderPage = Data<"m.order.list">;
export type OrderDetail = Data<"m.order.get">;
export type OrderTab = "all" | "producing" | "to_launch" | "live" | "ended" | "after_sale";
export const ORDER_TABS: readonly { key: OrderTab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "producing", label: "制作中" },
  { key: "to_launch", label: "待上线" },
  { key: "live", label: "上线中" },
  { key: "ended", label: "已结束" },
  { key: "after_sale", label: "售后" },
];
export function mergeOrders(previous: OrderPage, next: OrderPage): OrderPage {
  const seen = new Set(previous.items.map((i) => i.orderId));
  return {
    ...next,
    items: [
      ...previous.items,
      ...next.items.filter((i) => !seen.has(i.orderId) && Boolean(seen.add(i.orderId))),
    ],
  };
}
export function createOrderIntent(newKey: () => string) {
  let key = newKey();
  return {
    current: () => key,
    changed: () => {
      key = newKey();
      return key;
    },
  };
}
export function quoteRefreshMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.error === "QUOTE_CHANGED") return "报价已更新，请重新核对并同意协议";
  if (error.error === "AGREEMENT_VERSION_STALE") return "协议已更新，请重新阅读并同意";
  return null;
}
export function canSubmitOrder(
  quote: OrderQuote | null,
  accounts: readonly string[],
  focus: readonly string[],
  agreed: string | null,
): boolean {
  return Boolean(
    quote &&
    quote.blockers.length === 0 &&
    accounts.length > 0 &&
    accounts.length <= 2 &&
    new Set(accounts).size === accounts.length &&
    accounts.every((id) =>
      quote.channelAccounts.some((a) => a.channelAccountId === id && a.isSelectable),
    ) &&
    new Set(
      quote.channelAccounts
        .filter((a) => accounts.includes(a.channelAccountId))
        .map((a) => a.platform),
    ).size === accounts.length &&
    focus.length > 0 &&
    agreed === quote.agreement.agreementVersionId,
  );
}
export const createOrderLifetime = createCatalogLifetime;
interface State {
  scope: string;
  revision: number;
  ensureScope(): void;
  changed(): void;
}
export const useOrderStore = create<State>()((set, get) => ({
  scope: "",
  revision: 0,
  ensureScope: () => {
    const scope = scopeKey(catalogScope());
    if (scope !== get().scope) set({ scope, revision: 0 });
  },
  changed: () => set({ revision: get().revision + 1 }),
}));
