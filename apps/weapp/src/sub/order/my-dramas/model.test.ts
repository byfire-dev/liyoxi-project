import { describe, expect, it, vi } from "vitest";
import { dramaRow } from "../../../../shots/order-m5-fixtures";
import { createMyDramasApi } from "./api";
import type { DramaPage, DramaSummary } from "./api";
import { createMyDramasModel } from "./model";
const summary: DramaSummary = { all: 17, live: 11, to_launch: 4, ended: 2, delivering: 6 };
const page: DramaPage = { items: [dramaRow], nextCursor: "next+/?", hasMore: true };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup() {
  let scope = "owner:store1",
    allowed = true;
  const api = {
    list: vi.fn(async () => structuredClone(page)),
    summary: vi.fn(async () => summary),
    get: vi.fn(),
  };
  const model = createMyDramasModel({ api, scope: () => scope, allowed: () => allowed });
  return {
    model,
    api,
    changeScope() {
      scope = "owner:store2";
    },
    clerk() {
      allowed = false;
    },
  };
}
describe("我的短剧订单项读侧", () => {
  it("真实游标编码与服务器计数；同剧不同订单项保留，重复项去重，续页失败同游标重试", async () => {
    const urls: string[] = [];
    const api = createMyDramasApi(async <T>(url: string): Promise<T> => {
      urls.push(url);
      return structuredClone(page) as T;
    });
    await api.list("live", "next+/?");
    await api.summary();
    await api.get(dramaRow.orderItemId);
    expect(urls).toEqual([
      "/m/order-items?tab=live&limit=20&cursor=next%2B%2F%3F",
      "/m/order-items/summary",
      `/m/order-items/${dramaRow.orderItemId}`,
    ]);
    const f = setup();
    await f.model.refresh();
    expect(f.model.snapshot().summary).toBe(summary);
    f.api.list.mockRejectedValueOnce(new Error("网络中断"));
    await f.model.more();
    expect(f.model.snapshot().page?.items).toHaveLength(1);
    f.api.list.mockResolvedValueOnce({
      items: [dramaRow, { ...dramaRow, orderItemId: "different-item" }, dramaRow],
      nextCursor: null,
      hasMore: false,
    });
    await f.model.more();
    expect(f.api.list.mock.calls.slice(-2)).toEqual([
      ["all", "next+/?"],
      ["all", "next+/?"],
    ]);
    expect(f.model.snapshot().page?.items.map((item) => item.orderItemId)).toEqual([
      dramaRow.orderItemId,
      "different-item",
    ]);
    expect(f.model.snapshot().summary?.all).toBe(17);
  });
  it("换页签废弃迟到续页，换店/失权/卸载废弃旧结果且不再发请求", async () => {
    const f = setup();
    await f.model.refresh();
    const late = deferred<DramaPage>();
    f.api.list.mockImplementationOnce(() => late.promise);
    const pending = f.model.more();
    f.api.list.mockResolvedValueOnce({ items: [], nextCursor: null, hasMore: false });
    await f.model.refresh("ended");
    late.resolve(page);
    await pending;
    expect(f.model.snapshot().page?.items).toEqual([]);
    const old = deferred<DramaPage>();
    f.api.list.mockImplementationOnce(() => old.promise);
    const loading = f.model.refresh();
    f.changeScope();
    old.resolve(page);
    await loading;
    expect(f.model.snapshot().page).toBeNull();
    f.clerk();
    const calls = f.api.list.mock.calls.length;
    await f.model.refresh();
    expect(f.api.list).toHaveBeenCalledTimes(calls);
    f.model.dispose();
    await f.model.refresh();
    expect(f.api.list).toHaveBeenCalledTimes(calls);
  });
});
