import { describe, expect, it, vi } from "vitest";
import { makeMe } from "../../../../shots/account-fixtures";
import { assetCard, assetDetail, assetPage, assetSummary } from "../../../../shots/asset-fixtures";
import type { AssetApi, AssetPage } from "./api";
import { assetError, assetScope, createAssetResource } from "./resource";
import { ApiError } from "@/lib/request";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(id?: string) {
  let scope: string | null = "owner/store/token";
  const api = {
    list: vi.fn<AssetApi["list"]>().mockResolvedValue(assetPage()),
    summary: vi.fn<AssetApi["summary"]>().mockResolvedValue(assetSummary),
    detail: vi.fn<AssetApi["detail"]>().mockResolvedValue(assetDetail()),
  };
  const resource = createAssetResource({ api, scope: () => scope, id });
  return {
    api,
    resource,
    scope: (value: string | null) => {
      scope = value;
    },
  };
}
describe("素材上下文与请求代次", () => {
  it("没有令牌／当前成员店不读取；有效 scope 绑定真实角色、成员、主体与完整范围", () => {
    const me = makeMe(),
      store = { currentStoreId: me.memberships[0]!.stores[0]!.storeId, contextRev: 1 };
    const original = assetScope("token", store, me);
    expect(original).not.toBeNull();
    expect(assetScope(null, store, me)).toBeNull();
    expect(assetScope("token", { ...store, currentStoreId: null }, me)).toBeNull();
    expect(assetScope("token", store, { ...me, memberships: [] })).toBeNull();
    for (const change of [
      { ...me, memberships: me.memberships.map((m) => ({ ...m, role: "clerk" as const })) },
      { ...me, memberships: me.memberships.map((m) => ({ ...m, memberId: "other" })) },
      {
        ...me,
        memberships: me.memberships.map((m) => ({
          ...m,
          entity: { ...m.entity, entityId: "other" },
        })),
      },
      { ...me, memberships: me.memberships.map((m) => ({ ...m, stores: m.stores.slice(0, 1) })) },
    ])
      expect(assetScope("token", store, change)).not.toBe(original);
    expect(
      assetScope("token", store, {
        ...me,
        memberships: me.memberships.map((m) => ({ ...m, stores: [...m.stores].reverse() })),
      }),
    ).toBe(original);
  });
  it("scope 缺席时三 GET 均零调用", async () => {
    const h = setup();
    h.scope(null);
    await h.resource.refresh();
    await h.resource.more();
    await h.resource.change({ q: "门店" });
    expect(h.api.list).not.toHaveBeenCalled();
    expect(h.api.summary).not.toHaveBeenCalled();
    expect(h.api.detail).not.toHaveBeenCalled();
  });
  it.each(["role", "range", "store", "logout"])(
    "同令牌 %s 失效后旧成功／finally 不回写新页面",
    async (kind) => {
      const h = setup(),
        late = deferred<AssetPage>();
      h.api.list.mockReturnValueOnce(late.promise);
      const pending = h.resource.refresh();
      h.scope(kind === "logout" ? null : kind);
      h.resource.dispose();
      const fresh = setup();
      await fresh.resource.refresh();
      late.resolve(assetPage([99]));
      await pending;
      expect(h.resource.snapshot().page).toBeNull();
      expect(fresh.resource.snapshot().page?.items[0]?.storeAssetId).toBe(assetCard().storeAssetId);
      expect(fresh.resource.snapshot().loading).toBe(false);
    },
  );
  it.each(["success", "error"])("新筛选在途时旧 %s 及 finally 不解除新 busy", async (outcome) => {
    const h = setup(),
      old = deferred<AssetPage>(),
      fresh = deferred<AssetPage>();
    h.api.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = h.resource.refresh(),
      second = h.resource.change({ q: "新筛选" });
    if (outcome === "success") old.resolve(assetPage([99]));
    else old.reject(new Error("signed-secret"));
    await first;
    expect(h.resource.snapshot()).toMatchObject({ loading: true, page: null, error: null });
    fresh.resolve(assetPage([2]));
    await second;
    expect(h.resource.snapshot().page?.items[0]?.storeAssetId).toBe(assetCard(2).storeAssetId);
  });
  it("account.start 迟到及隐藏使读取失效；再次准备只读新上下文", async () => {
    const h = setup(),
      ready = deferred<void>();
    const pending = h.resource.prepare(() => ready.promise);
    h.resource.suspend();
    ready.resolve();
    await pending;
    expect(h.api.list).not.toHaveBeenCalled();
    await h.resource.prepare(async () => undefined);
    expect(h.api.list).toHaveBeenCalledTimes(1);
    h.resource.suspend();
    expect(h.resource.snapshot().page).toBeNull();
  });
  it("卸载后旧失败不发布，解除订阅不再通知", async () => {
    const h = setup(),
      late = deferred<AssetPage>(),
      listener = vi.fn();
    h.api.list.mockReturnValueOnce(late.promise);
    const off = h.resource.subscribe(listener),
      pending = h.resource.refresh();
    off();
    const before = listener.mock.calls.length;
    h.resource.dispose();
    late.reject(new Error("private URL"));
    await pending;
    expect(listener).toHaveBeenCalledTimes(before);
    expect(h.resource.snapshot().page).toBeNull();
  });
});
describe("素材筛选与分页", () => {
  it("summary 真计数独立于当前页，筛选同时传给 list/summary", async () => {
    const h = setup();
    await h.resource.change(
      { q: "  门店  ", uploader: "me", status: "ready", tag: "store" },
      "image",
    );
    expect(h.api.list).toHaveBeenCalledWith(
      { q: "门店", uploader: "me", status: "ready", tag: "store" },
      "image",
    );
    expect(h.api.summary).toHaveBeenCalledWith({
      q: "门店",
      uploader: "me",
      status: "ready",
      tag: "store",
    });
    expect(h.resource.snapshot().summary?.tabs.all).toBe(26);
    expect(h.resource.snapshot().page?.items).toHaveLength(3);
  });
  it("summary 失败不填零也不丢成功列表；刷新可独立恢复", async () => {
    const h = setup();
    h.api.summary.mockRejectedValueOnce(new Error("private"));
    await h.resource.refresh();
    expect(h.resource.snapshot().summary).toBeNull();
    expect(h.resource.snapshot().summaryError).toBeTruthy();
    expect(h.resource.snapshot().page?.items).toHaveLength(3);
    await h.resource.refresh();
    expect(h.resource.snapshot().summary).toEqual(assetSummary);
    expect(h.resource.snapshot().summaryError).toBeNull();
  });
  it.each(["😀".repeat(30), "中".repeat(30)])("30码点搜索接受：%s", async (q) => {
    const h = setup();
    await h.resource.change({ q });
    expect(h.api.list).toHaveBeenCalledTimes(1);
  });
  it("31码点拒绝且旧页清除，空输入移除 q", async () => {
    const h = setup();
    await h.resource.refresh();
    h.api.list.mockClear();
    await h.resource.change({ q: "😀".repeat(31) });
    expect(h.api.list).not.toHaveBeenCalled();
    expect(h.resource.snapshot().page).toBeNull();
    expect(h.resource.snapshot().error).toContain("30");
    await h.resource.change({ q: "  " });
    expect(h.api.list).toHaveBeenCalledWith({ q: undefined }, "all");
  });
  it("更多同步单飞、跨页和同页去重并保先前快照；末页不再请求", async () => {
    const h = setup(),
      late = deferred<AssetPage>();
    h.api.list.mockResolvedValueOnce(assetPage([1, 2], true)).mockReturnValueOnce(late.promise);
    await h.resource.refresh();
    const a = h.resource.more(),
      b = h.resource.more();
    expect(h.api.list).toHaveBeenCalledTimes(2);
    late.resolve({
      ...assetPage([2, 3, 3]),
      items: [{ ...assetCard(2), title: "后到覆盖" }, assetCard(3), assetCard(3)],
    });
    await Promise.all([a, b]);
    expect(h.resource.snapshot().page?.items.map((i) => i.storeAssetId)).toEqual(
      [1, 2, 3].map((n) => assetCard(n).storeAssetId),
    );
    expect(h.resource.snapshot().page?.items[1]?.title).toBeNull();
    await h.resource.more();
    expect(h.api.list).toHaveBeenCalledTimes(2);
  });
  it("分页失败保原页可重试，筛选作废旧 cursor 结果", async () => {
    const h = setup();
    h.api.list
      .mockResolvedValueOnce(assetPage([1], true))
      .mockRejectedValueOnce(new Error("private"));
    await h.resource.refresh();
    await h.resource.more();
    expect(h.resource.snapshot().page?.items).toHaveLength(1);
    expect(h.resource.snapshot().moreError).toBeTruthy();
    const late = deferred<AssetPage>();
    h.api.list.mockReturnValueOnce(late.promise);
    const pending = h.resource.more();
    await h.resource.change({ tag: "new" });
    late.resolve(assetPage([99]));
    await pending;
    expect(
      h.resource.snapshot().page?.items.some((i) => i.storeAssetId === assetCard(99).storeAssetId),
    ).toBe(false);
    expect(h.resource.snapshot().moreLoading).toBe(false);
  });
  it("detail 只调用详情且失败清除旧签名，错误不回显私有消息", async () => {
    const h = setup("asset");
    await h.resource.refresh();
    expect(h.api.list).not.toHaveBeenCalled();
    expect(h.api.summary).not.toHaveBeenCalled();
    h.api.detail.mockRejectedValueOnce(new Error("https://signed.invalid/secret"));
    await h.resource.refresh();
    expect(h.resource.snapshot().detail).toBeNull();
    expect(h.resource.snapshot().error).not.toContain("secret");
    expect(
      assetError(
        new ApiError({ error: "NOT_FOUND", status: 404, message: "private", requestId: "id" }),
      ),
    ).toBe("素材不存在或已移除");
  });
});
