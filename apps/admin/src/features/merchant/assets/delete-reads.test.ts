import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createAssetDeleteReads } from "./delete-reads";
import { ASSET_READ_KEY } from "./model";

const prefix = [...ASSET_READ_KEY, "staff:fixture", "store-a"],
  detailKey = [...prefix, "detail", "asset-a", { assetTab: "all" }];
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

describe("素材删除的读取生命周期", () => {
  it("发送前停止详情自动读取并取消在途请求，晚返回不能复活删除后的缓存", async () => {
    const query = client(),
      changed = vi.fn();
    const reads = createAssetDeleteReads(query, "staff:fixture", "store-a", "asset-a", changed);
    let finish!: (value: string) => void;
    const aborted = vi.fn(),
      fetch = vi.fn(({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener("abort", aborted);
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      });
    const detail = new QueryObserver(query, {
      queryKey: detailKey,
      queryFn: fetch,
      enabled: () => !reads.paused(),
    });
    const unsubscribe = detail.subscribe(() => {});
    expect(fetch).toHaveBeenCalledOnce();
    await reads.before();
    expect(aborted).toHaveBeenCalledOnce();
    await query.invalidateQueries({ queryKey: [...prefix, "detail"] });
    expect(fetch).toHaveBeenCalledOnce();
    await reads.committed();
    finish("过时详情");
    await Promise.resolve();
    expect(query.getQueryData(detailKey)).toBeUndefined();
    expect(query.getQueryCache().find({ queryKey: detailKey, exact: true })).toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    query.clear();
  });

  it("确认成功只刷新当前 scope/门店的列表与汇总，其他详情和门店保持原样", async () => {
    const query = client(),
      reads = createAssetDeleteReads(query, "staff:fixture", "store-a", "asset-a", () => {});
    const keys = [
      [...prefix, "list", { page: 1 }],
      [...prefix, "summary", {}],
      [...prefix, "detail", "asset-b", {}],
      [...prefix, "vocabulary"],
      [...ASSET_READ_KEY, "staff:other", "store-a", "list", {}],
      [...ASSET_READ_KEY, "staff:fixture", "store-b", "list", {}],
    ];
    query.setQueryData(detailKey, "已删除详情");
    const functions = keys.map(() => vi.fn(async () => "新事实"));
    const subscriptions = keys.map((key, index) => {
      query.setQueryData(key, "旧事实");
      return new QueryObserver(query, {
        queryKey: key,
        queryFn: functions[index],
        staleTime: Infinity,
      }).subscribe(() => {});
    });
    await reads.before();
    await reads.committed();
    expect(functions.map((fetch) => fetch.mock.calls.length)).toEqual([1, 1, 0, 0, 0, 0]);
    expect(query.getQueryData(detailKey)).toBeUndefined();
    for (const unsubscribe of subscriptions) unsubscribe();
    query.clear();
  });

  it("明确失败恢复原详情读取而不执行成功清理，支持冲突后的事实回读", async () => {
    const query = client(),
      reads = createAssetDeleteReads(query, "staff:fixture", "store-a", "asset-a", () => {});
    query.setQueryData(detailKey, "原详情");
    const fetch = vi.fn(async () => "冲突后的详情");
    const detail = new QueryObserver(query, {
      queryKey: detailKey,
      queryFn: fetch,
      staleTime: Infinity,
      enabled: () => !reads.paused(),
    });
    const unsubscribe = detail.subscribe(() => {});
    await reads.before();
    expect(query.getQueryData(detailKey)).toBe("原详情");
    reads.restore();
    await query.invalidateQueries({ queryKey: prefix });
    expect(fetch).toHaveBeenCalledOnce();
    expect(query.getQueryData(detailKey)).toBe("冲突后的详情");
    expect(reads.paused()).toBe(false);
    unsubscribe();
    query.clear();
  });

  it("未知结果取消只退出详情并真实刷新集合，不恢复可能已删详情或伪造列表结果", async () => {
    const query = client(),
      reads = createAssetDeleteReads(query, "staff:fixture", "store-a", "asset-a", () => {}),
      listKey = [...prefix, "list", {}];
    query.setQueryData(detailKey, "原详情");
    query.setQueryData(listKey, ["asset-a"]);
    const detailFetch = vi.fn(async () => "不得再读取"),
      listFetch = vi.fn(async () => ["asset-a"]);
    const detail = new QueryObserver(query, {
      queryKey: detailKey,
      queryFn: detailFetch,
      staleTime: Infinity,
      enabled: () => !reads.paused(),
    });
    const list = new QueryObserver(query, {
      queryKey: listKey,
      queryFn: listFetch,
      staleTime: Infinity,
    });
    const unsubscribeDetail = detail.subscribe(() => {}),
      unsubscribeList = list.subscribe(() => {});
    await reads.before();
    await reads.dismiss();
    expect(detailFetch).not.toHaveBeenCalled();
    expect(reads.paused()).toBe(true);
    expect(query.getQueryData(detailKey)).toBeUndefined();
    expect(listFetch).toHaveBeenCalledOnce();
    expect(query.getQueryData(listKey)).toEqual(["asset-a"]);
    unsubscribeDetail();
    unsubscribeList();
    query.clear();
  });
});
