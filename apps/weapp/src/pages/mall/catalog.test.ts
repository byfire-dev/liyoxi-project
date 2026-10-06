import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestLayer, RequestOptions } from "@/lib/request";
import {
  createCatalogLifetime,
  cartForRole,
  cartIntent,
  concatCards,
  mergeDramaPage,
  scopeGuard,
  selectedPoints,
  useCatalogStore,
  viewerRole,
  type CatalogScope,
} from "@/stores/catalog";
import { catalogCard, catalogCartItem } from "../../../shots/catalog-fixtures";
import { makeMe } from "../../../shots/account-fixtures";
vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
import { createCatalogApi } from "./api";
let sequence = 0;
beforeEach(() => useCatalogStore.getState().ensureScope(`test-${++sequence}`));
describe("商城意图、游标与门店边界", () => {
  it("游标拼接去重并保留既有快照，后页和重发页不丢失", () => {
    const first = [catalogCard(1), catalogCard(2)],
      next = [catalogCard(2), catalogCard(3), catalogCard(3)];
    expect(concatCards(first, next).map((i) => i.dramaId)).toEqual(
      [1, 2, 3].map((n) => catalogCard(n).dramaId),
    );
    const previous = {
      viewerRole: "owner",
      viewerPlan: null,
      items: first,
      nextCursor: "next",
      hasMore: true,
    } as const;
    const page = mergeDramaPage(previous, {
      ...previous,
      items: next,
      nextCursor: null,
      hasMore: false,
    });
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.items[0]).toEqual(first[0]);
    expect(
      mergeDramaPage(page, { ...previous, items: next, hasMore: false, nextCursor: null }).items,
    ).toHaveLength(3);
  });
  it("合计只累加服务端S，变价/失效/无S不当成0或用P重算", () => {
    const a = catalogCartItem(1),
      b = { ...catalogCartItem(2), discountedPoints: 801 };
    expect(selectedPoints([a, b], [a.cartItemId, b.cartItemId])).toBe(1701);
    for (const state of ["invalid", "price_changed"])
      expect(selectedPoints([{ ...a, state }], [a.cartItemId])).toBeNull();
    expect(selectedPoints([{ ...a, discountedPoints: null }], [a.cartItemId])).toBeNull();
    expect(selectedPoints([a], [])).toBe(0);
  });
  it("同一次价格确认重试同key，价或动作改变才新意图", () => {
    const key = vi
      .fn()
      .mockReturnValueOnce("intent1")
      .mockReturnValueOnce("intent2")
      .mockReturnValueOnce("intent3");
    const first = cartIntent(null, "accept", "item", 1200, key);
    expect(cartIntent(first, "accept", "item", 1200, key)).toBe(first);
    const repriced = cartIntent(first, "accept", "item", 1300, key);
    expect(repriced.key).toBe("intent2");
    expect(cartIntent(repriced, "delete", "item", null, key).key).toBe("intent3");
    expect(key).toHaveBeenCalledTimes(3);
  });
  it("acceptPrice真实发送P与原key；自然create不伪造required键", async () => {
    const calls: [string, RequestOptions | undefined][] = [];
    const send: RequestLayer["request"] = async <T>(path: string, options?: RequestOptions) => {
      calls.push([path, options]);
      return null as T;
    };
    const api = createCatalogApi(send);
    await api.accept("item", 1200, "same-key");
    await api.accept("item", 1200, "same-key");
    await api.add("drama");
    expect(calls.slice(0, 2)).toEqual(
      Array.from({ length: 2 }, () => [
        "/m/cart-items/item/accept-price",
        { method: "POST", idempotencyKey: "same-key", data: { acceptedPricePoints: 1200 } },
      ]),
    );
    expect(calls[2]?.[1]?.idempotencyKey).toBeUndefined();
  });
  it("店员与游客不发cart请求；角色从typed membership及当前店取", async () => {
    const read = vi.fn();
    await cartForRole("clerk", read);
    await cartForRole("guest", read);
    expect(read).not.toHaveBeenCalled();
    const me = makeMe(true),
      scope = { storeId: me.memberships[0]!.stores[0]!.storeId, contextRev: 1, token: "fake" };
    expect(viewerRole(me, scope)).toBe("clerk");
    expect(viewerRole(me, { ...scope, storeId: "foreign" })).toBe("guest");
    expect(viewerRole(me, { ...scope, token: null })).toBe("guest");
  });
  it("切店/退出废弃在途成功和错误；同店旧contextRev也不可复用", async () => {
    let scope: CatalogScope = { storeId: "a", contextRev: 1, token: "fake" };
    const current = scopeGuard(() => scope);
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    }).then(() => current());
    scope = { ...scope, storeId: "b", contextRev: 2 };
    release();
    expect(await pending).toBe(false);
    const next = scopeGuard(() => scope);
    scope = { ...scope, token: null };
    expect(next()).toBe(false);
    const sameStore = scopeGuard(() => scope);
    scope = { ...scope, contextRev: 3 };
    expect(sameStore()).toBe(false);
  });
  it("卸载后的在途成功/错误不发布，新读取立即废弃旧读取", async () => {
    const life = createCatalogLifetime(() => ({ storeId: "a", contextRev: 1, token: "fake" }));
    const old = life.read(),
      latest = life.read();
    expect(old()).toBe(false);
    expect(latest()).toBe(true);
    const write = life.capture();
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    }).then(() => write());
    life.dispose();
    release();
    expect(await pending).toBe(false);
    expect(latest()).toBe(false);
    life.mount();
    const next = life.read();
    expect(next()).toBe(true);
    expect(old()).toBe(false);
  });
  it("重复加入角标只加一次、无效项排除、切店清选剧缓存与筛选", () => {
    const store = useCatalogStore.getState();
    store.setBadge(2);
    store.added("same", false);
    store.added("same", false);
    expect(useCatalogStore.getState().badge).toBe(3);
    store.added("known", true);
    expect(useCatalogStore.getState().badge).toBe(3);
    store.reconcileCart([catalogCartItem(1), { ...catalogCartItem(2), state: "invalid" }]);
    expect(useCatalogStore.getState().badge).toBe(1);
    store.setCategory("life");
    store.ensureScope("next-store");
    expect(useCatalogStore.getState()).toMatchObject({
      badge: null,
      knownCartIds: [],
      category: "",
      revisions: {},
    });
  });
});
