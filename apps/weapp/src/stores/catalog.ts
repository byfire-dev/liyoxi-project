import { create } from "zustand";
import type { components, operations } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import { useContextStore } from "./context";
import { useSessionStore } from "./session";
export type Home = Data<"m.home.get">;
export type DramaPage = Data<"m.drama.list">;
export type DramaCard = DramaPage["items"][number];
export type DramaDetail = Data<"m.drama.get">;
export type MallConfig = Data<"m.mallConfig.get">;
export type DramaQuery = NonNullable<operations["m.drama.list"]["parameters"]["query"]>;
export type Cart = Data<"m.cartItem.list">;
export type CartItem = Cart["items"][number];
export type ViewerRole = "owner" | "clerk" | "guest";
export interface CatalogScope {
  storeId: string | null;
  contextRev: number;
  token: string | null;
}
export const catalogScope = (): CatalogScope => ({
  storeId: useContextStore.getState().currentStoreId,
  contextRev: useContextStore.getState().contextRev,
  token: useSessionStore.getState().accessToken,
});
export const scopeKey = (s: CatalogScope) => `${s.contextRev}:${s.storeId}:${s.token}`;
export function scopeGuard(read: () => CatalogScope = catalogScope) {
  const captured = scopeKey(read());
  return () => captured === scopeKey(read());
}
export function viewerRole(
  me: components["schemas"]["MeView"] | null,
  s: CatalogScope,
): ViewerRole {
  if (!s.token || !s.storeId) return "guest";
  const role = me?.memberships.find((m) =>
    m.stores.some((store) => store.storeId === s.storeId),
  )?.role;
  return role === "owner" ? "owner" : role === "clerk" ? "clerk" : "guest";
}
function concatUnique<T extends { dramaId: string }>(previous: T[], next: T[]): T[] {
  const seen = new Set(previous.map((item) => item.dramaId));
  return [
    ...previous,
    ...next.filter((item) => !seen.has(item.dramaId) && Boolean(seen.add(item.dramaId))),
  ];
}
export const concatCards = (previous: DramaCard[], next: DramaCard[]) =>
  concatUnique(previous, next);
export function mergeDramaPage(previous: DramaPage, next: DramaPage): DramaPage {
  if (previous.viewerRole !== next.viewerRole) return next;
  // 联合按角色逐个缩窄，保留真实owner专用字段，不cast覆盖响应。
  if (next.viewerRole === "owner" && previous.viewerRole === "owner")
    return {
      ...next,
      items: concatUnique(previous.items, next.items),
    };
  if (next.viewerRole === "clerk" && previous.viewerRole === "clerk")
    return { ...next, items: concatCards(previous.items, next.items) };
  if (next.viewerRole === "guest" && previous.viewerRole === "guest")
    return { ...next, items: concatCards(previous.items, next.items) };
  return next;
}
export function selectedPoints(items: CartItem[], ids: readonly string[]): number | null {
  const selected = items.filter((item) => ids.includes(item.cartItemId));
  if (selected.some((item) => item.state !== "valid" || item.discountedPoints === null))
    return null;
  // m04 §3.10 允许展示服务器逐项S的合计；真正报价交 PR2 quote。
  return selected.reduce((sum, item) => sum + item.discountedPoints!, 0);
}
export interface CartIntent {
  action: "delete" | "accept";
  id: string;
  price: number | null;
  key: string;
}
export function cartIntent(
  previous: CartIntent | null,
  action: CartIntent["action"],
  id: string,
  price: number | null,
  key: () => string,
): CartIntent {
  return previous?.action === action && previous.id === id && previous.price === price
    ? previous
    : { action, id, price, key: key() };
}
interface CatalogState {
  scope: string;
  revisions: Record<string, number>;
  badge: number | null;
  knownCartIds: string[];
  category: string;
  ensureScope(scope: string): void;
  changed(): void;
  setCategory(category: string): void;
  setBadge(count: number): void;
  reconcileCart(items: CartItem[]): void;
  added(id: string, wasPresent: boolean): void;
  removed(id: string, wasCounted: boolean): void;
}
export const useCatalogStore = create<CatalogState>()((set, get) => ({
  scope: "",
  revisions: {},
  badge: null,
  knownCartIds: [],
  category: "",
  ensureScope: (scope) => {
    if (get().scope !== scope)
      set({ scope, revisions: {}, badge: null, knownCartIds: [], category: "" });
  },
  changed: () => {
    const id = useContextStore.getState().currentStoreId ?? "guest";
    set({ revisions: { ...get().revisions, [id]: (get().revisions[id] ?? 0) + 1 } });
  },
  setCategory: (category) => set({ category }),
  setBadge: (badge) => set({ badge }),
  reconcileCart: (items) =>
    set({
      knownCartIds: items.map((i) => i.cartItemId),
      badge: items.filter((i) => i.state !== "invalid").length,
    }),
  added: (id, wasPresent) => {
    const s = get();
    if (!s.knownCartIds.includes(id))
      set({
        knownCartIds: [...s.knownCartIds, id],
        badge: s.badge === null ? null : s.badge + (wasPresent ? 0 : 1),
      });
    get().changed();
  },
  removed: (id, wasCounted) => {
    const s = get();
    if (s.knownCartIds.includes(id))
      set({
        knownCartIds: s.knownCartIds.filter((v) => v !== id),
        badge: s.badge === null ? null : Math.max(0, s.badge - (wasCounted ? 1 : 0)),
      });
    get().changed();
  },
}));

export const cartForRole = (role: ViewerRole, read: () => Promise<Cart>): Promise<Cart | null> =>
  role === "owner" ? read() : Promise.resolve(null);

/** 每页自己的生命周期与读取代次；与账户/门店快照一起拒绝旧成功和旧错误。 */
export function createCatalogLifetime(read: () => CatalogScope = catalogScope) {
  let alive = true,
    generation = 0,
    lifecycle = 0;
  const invalidate = () => {
    generation++;
  };
  return {
    mount: () => {
      if (!alive) {
        alive = true;
        lifecycle++;
      }
    },
    dispose: () => {
      alive = false;
      lifecycle++;
      invalidate();
    },
    invalidate,
    read: () => {
      const own = ++generation,
        scope = scopeGuard(read);
      return () => alive && own === generation && scope();
    },
    capture: (includeRead = false) => {
      const own = generation,
        ownLife = lifecycle,
        scope = scopeGuard(read);
      return () =>
        alive && ownLife === lifecycle && scope() && (!includeRead || own === generation);
    },
  };
}
