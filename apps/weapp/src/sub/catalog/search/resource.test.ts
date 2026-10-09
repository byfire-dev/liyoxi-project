import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "@/lib/platform";
import { createSearchHistory } from "@/lib/search-history";
import { searchConfig, searchPage } from "../../../../shots/search-fixtures";
import type { SearchApi, SearchPage } from "./api";
import { createSearchResource } from "./resource";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const values = new Map<string, unknown>();
  const storage: KeyValueStorage = {
    get: <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: (key, v) => {
      values.set(key, v);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
  const local = { scope: "1:store:token" };
  const api = {
    config: vi.fn<SearchApi["config"]>(async () => searchConfig),
    search: vi.fn<SearchApi["search"]>(async () => searchPage()),
  };
  const resource = createSearchResource({
    api,
    history: createSearchHistory(storage),
    scope: () => local.scope,
  });
  return { resource, api, local, values };
}
afterEach(() => vi.useRealTimers());
describe("搜索页面资源隔离", () => {
  it("300ms防抖实际仅最后一次；输入不写历史/空输入无请求", async () => {
    vi.useFakeTimers();
    const { resource, api } = setup();
    resource.change("都");
    await vi.advanceTimersByTimeAsync(200);
    resource.change("都 市·生活");
    await vi.advanceTimersByTimeAsync(299);
    expect(api.search).not.toHaveBeenCalled();
    expect(resource.snapshot().history).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.search).toHaveBeenCalledExactlyOnceWith("都市生活");
    expect(resource.snapshot().history).toEqual(["都市生活"]);
    resource.change(" · ");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(resource.snapshot()).toMatchObject({ query: "", page: null, loading: false });
  });
  it("确认/热词/历史立即提交并取消输入timer；超长不发不记", async () => {
    vi.useFakeTimers();
    const { resource, api } = setup();
    resource.change("旧词");
    await resource.submit("火锅");
    await vi.advanceTimersByTimeAsync(500);
    expect(api.search).toHaveBeenCalledExactlyOnceWith("火锅");
    await resource.submit("关键词".repeat(10));
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(resource.snapshot().error).toBe("请输入1–20字搜索词");
    expect(resource.snapshot().history).toEqual(["火锅"]);
    resource.clearHistory();
    expect(resource.snapshot().history).toEqual([]);
  });
  it.each(["success", "error"] as const)(
    "旧query %s和finally不能写新轮页面/loading",
    async (outcome) => {
      const { resource, api } = setup();
      const old = deferred<SearchPage>(),
        next = deferred<SearchPage>();
      api.search.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const first = resource.submit("旧词"),
        second = resource.submit("新词");
      if (outcome === "success") old.resolve(searchPage("owner"));
      else old.reject(new Error("旧错误"));
      await first;
      expect(resource.snapshot()).toMatchObject({
        query: "新词",
        loading: true,
        error: null,
        page: null,
      });
      next.resolve(searchPage("guest"));
      await second;
      expect(resource.snapshot().page?.viewerRole).toBe("guest");
      expect(resource.snapshot().loading).toBe(false);
    },
  );
  it.each(["store", "token", "contextRev"])(
    "%s切换后旧成功/错误/续页不回写，新resource独立",
    async (change) => {
      const { resource, api, local } = setup();
      const old = deferred<SearchPage>();
      api.search.mockReturnValueOnce(old.promise);
      const first = resource.submit("旧词");
      const before = resource.snapshot();
      local.scope += `:${change}`;
      old.resolve(searchPage());
      await first;
      expect(resource.snapshot()).toBe(before);
      await resource.submit("不得发");
      expect(api.search).toHaveBeenCalledTimes(1);
    },
  );
  it("更多单飞/真实cursor，失败保留旧20项重试；重复项只保第一份", async () => {
    const { resource, api } = setup();
    api.search.mockResolvedValueOnce(searchPage("owner", { ids: [1, 2], hasMore: true }));
    await resource.submit("生活");
    const first = resource.snapshot().page;
    const pending = deferred<SearchPage>();
    api.search.mockReturnValueOnce(pending.promise);
    const more = resource.more();
    await resource.more();
    expect(api.search).toHaveBeenCalledTimes(2);
    pending.reject(new Error("更多网络失败"));
    await more;
    expect(resource.snapshot().page).toBe(first);
    expect(resource.snapshot()).toMatchObject({
      moreLoading: false,
      moreError: "更多网络失败",
      error: null,
    });
    api.search.mockResolvedValueOnce(searchPage("owner", { ids: [2, 3] }));
    await resource.more();
    expect(api.search).toHaveBeenLastCalledWith("生活", "opaque:search+cursor/first");
    expect(resource.snapshot().page?.items).toHaveLength(3);
  });
  it("旧续页错误/finally不能清新首屏和新更多的loading", async () => {
    const { resource, api } = setup();
    api.search.mockResolvedValueOnce(searchPage("owner", { hasMore: true }));
    await resource.submit("旧");
    const old = deferred<SearchPage>();
    api.search.mockReturnValueOnce(old.promise);
    const more = resource.more();
    api.search.mockResolvedValueOnce(searchPage("guest", { ids: [5], hasMore: true }));
    await resource.submit("新");
    const newer = deferred<SearchPage>();
    api.search.mockReturnValueOnce(newer.promise);
    const nextMore = resource.more();
    old.reject(new Error("过期更多错误"));
    await more;
    expect(resource.snapshot()).toMatchObject({ query: "新", moreLoading: true, moreError: null });
    newer.resolve(searchPage("guest", { ids: [6] }));
    await nextMore;
    expect(resource.snapshot().page?.items).toHaveLength(2);
  });
  it("配置只取已发布顺序；旧配置/卸载响应不回写；dispose清timer", async () => {
    vi.useFakeTimers();
    const { resource, api } = setup();
    const old = deferred<typeof searchConfig>();
    api.config.mockReturnValueOnce(old.promise);
    const first = resource.config();
    await resource.config();
    old.reject(new Error("旧配置错误"));
    await first;
    expect(resource.snapshot()).toMatchObject({
      config: searchConfig,
      configError: null,
      configLoading: false,
    });
    const listener = vi.fn();
    resource.subscribe(listener);
    resource.change("卸载");
    resource.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(api.search).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
