import type { Body } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { useContextStore } from "../src/stores/context";
import { assetCard, assetId } from "./asset-fixtures";
import { offlineOrderRequest, orderDetail, ORDER_ID } from "./order-fixtures";
export const referenceCards = [
  { ...assetCard(31), title: "门店日常实拍" },
  {
    ...assetCard(32),
    title: "员工服务记录",
    displayStatus: "need_portrait_auth" as const,
    usability: "need_portrait_auth" as const,
  },
  {
    ...assetCard(33),
    title: "当前不可参考素材",
    displayStatus: "need_reshoot" as const,
    usability: "need_reshoot" as const,
    isSelectableAsReference: false,
  },
];
export function offlineOrderReferenceRequest(_scene: string): RequestLayer["request"] {
  const base = offlineOrderRequest("checkout-default");
  const calls: { path: string; method: string; data?: unknown; key?: string }[] = [];
  let selected: string[] = [],
    held = false;
  const pending: (() => void)[] = [];
  const originalStore = useContextStore.getState().currentStoreId;
  const control = {
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      pending.splice(0).forEach((run) => run());
    },
    switchStore: () =>
      useContextStore
        .getState()
        .switchStore(
          originalStore === "00000000-0000-4000-8000-000000000001"
            ? "00000000-0000-4000-8000-000000000002"
            : "00000000-0000-4000-8000-000000000001",
        ),
  };
  (globalThis as { __LYX_ORDER_REFERENCE_CALLS__?: typeof calls }).__LYX_ORDER_REFERENCE_CALLS__ =
    calls;
  (
    globalThis as { __LYX_ORDER_REFERENCE_CONTROL__?: typeof control }
  ).__LYX_ORDER_REFERENCE_CONTROL__ = control;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const method = options?.method ?? "GET";
    calls.push({ path, method, data: options?.data, key: options?.idempotencyKey });
    const url = new URL(path, "https://offline.invalid");
    if (url.pathname === "/m/store-assets") {
      const priorStore = useContextStore.getState().currentStoreId;
      const items =
        priorStore === originalStore
          ? referenceCards
          : [{ ...assetCard(41), title: "新门店独立素材" }];
      if (held) await new Promise<void>((resolve) => pending.push(resolve));
      const ids = url.searchParams.get("ids")?.split(",");
      return {
        items: items.filter((item) => !ids || ids.includes(item.storeAssetId)),
        hasMore: false,
        nextCursor: null,
      } as T;
    }
    if (url.pathname === "/m/orders" && method === "POST") {
      selected = (options?.data as Body<"m.order.create">).referenceStoreAssetIds ?? [];
    }
    if (url.pathname === `/m/orders/${ORDER_ID}` && method === "GET")
      return { ...orderDetail, referenceStoreAssetIds: [...selected] } as T;
    return base<T>(path, options);
  };
}
export const referenceIds = [assetId(31), assetId(32)];
