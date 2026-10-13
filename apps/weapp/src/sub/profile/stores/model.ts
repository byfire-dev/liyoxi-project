import type { Stores, Store } from "../../member/members/api";
export function permittedStoreAction(data: Stores, storeId: string, action: string) {
  return (
    data.viewerRole === "owner" &&
    data.items.some((s) => s.storeId === storeId && s.actions.some((a) => a === action))
  );
}
export const storeName = (store: Store) => store.name ?? "未命名门店";
