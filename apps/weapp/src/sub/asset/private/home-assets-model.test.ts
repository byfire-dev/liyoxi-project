import { describe, expect, it, vi } from "vitest";
import { makeMe } from "../../../../shots/account-fixtures";
import { homeAssetDemands } from "../../../../shots/asset-home-fixtures";
import { assetSummary } from "../../../../shots/asset-fixtures";
import { ApiError, type RequestLayer } from "@/lib/request";
import { createAssetApi, type AssetSummary } from "./api";
import { createHomeAssetsApi, type HomeAssetsApi } from "./home-assets-api";
import { createAssetResource } from "./resource";
import type { DemandPage } from "./upload-api";
import {
  createHomeAssetsResource,
  homeAssetDemandEntry,
  homeAssetLibraryEntry,
  homeAssetLibraryUrl,
  homeAssetsScope,
  homeAssetUploadUrl,
} from "./home-assets-model";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(initial: string | null = "owner/store/token") {
  let scope = initial;
  const api = {
    demands: vi.fn<HomeAssetsApi["demands"]>().mockResolvedValue(homeAssetDemands),
    summary: vi.fn<HomeAssetsApi["summary"]>().mockResolvedValue(assetSummary),
  };
  return {
    api,
    resource: createHomeAssetsResource({ api, scope: () => scope }),
    scope: (value: string | null) => {
      scope = value;
    },
  };
}
describe("首页素材最后留桩", () => {
  it("仅正式开放需求与本人摘要；真实 ID／筛选进入旧上传和素材库，不推算计数", async () => {
    const calls: { path: string; options: unknown }[] = [];
    const send: RequestLayer["request"] = async <T>(
      path: string,
      options?: Parameters<RequestLayer["request"]>[1],
    ): Promise<T> => {
      calls.push({ path, options });
      if (path.startsWith("/m/asset-demands")) return homeAssetDemands as T;
      if (path.startsWith("/m/store-assets/summary")) return assetSummary as T;
      return { items: [], hasMore: false, nextCursor: null } as T;
    };
    const resource = createHomeAssetsResource({
      api: createHomeAssetsApi(send),
      scope: () => "clerk",
    });
    await resource.prepare(async () => undefined);
    expect(calls).toEqual([
      { path: "/m/asset-demands?status=open&limit=20", options: undefined },
      { path: "/m/store-assets/summary?uploader=me", options: undefined },
    ]);
    expect(resource.snapshot().summary).toBe(assetSummary);
    expect(resource.snapshot().demands).toBe(homeAssetDemands);
    const id = homeAssetDemands.items[0]!.assetDemandId;
    expect(homeAssetUploadUrl(id)).toBe(`/sub/asset/upload/index?assetDemandId=${id}`);
    expect(homeAssetUploadUrl()).toBe("/sub/asset/upload/index");
    expect(homeAssetDemandEntry(id, homeAssetDemands)).toBe(id);
    expect(homeAssetDemandEntry("foreign", homeAssetDemands)).toBeNull();
    expect(
      homeAssetDemandEntry(id, {
        ...homeAssetDemands,
        items: [{ ...homeAssetDemands.items[0]!, status: "canceled" }],
      }),
    ).toBeNull();
    expect(homeAssetLibraryEntry({ uploader: "other", status: "invented" })).toEqual({});
    const url = new URL(homeAssetLibraryUrl(true), "http://local");
    const filters = homeAssetLibraryEntry(Object.fromEntries(url.searchParams));
    expect(filters).toEqual({ uploader: "me", status: "adopted" });
    const library = createAssetResource({
      api: createAssetApi(send),
      scope: () => "clerk",
      initialFilters: filters,
    });
    await library.prepare(async () => undefined);
    expect(calls.at(-2)?.path).toContain("uploader=me&status=adopted");
    expect(calls.at(-1)?.path).toBe("/m/store-assets/summary?uploader=me&status=adopted");
    expect(library.snapshot().filters).toEqual(filters);
    expect(homeAssetLibraryUrl()).toBe("/sub/asset/lib/index?uploader=me");
  });
  it("owner/clerk 需当前成员范围；令牌／ctxRev／角色／成员／主体／范围变化与离页拒绝迟到", async () => {
    const me = makeMe(),
      store = { currentStoreId: me.memberships[0]!.stores[0]!.storeId, contextRev: 1 };
    const key = homeAssetsScope("token", store, me);
    expect(key).toBeTruthy();
    expect(homeAssetsScope("token", store, makeMe(true))).toBeTruthy();
    for (const absent of [
      homeAssetsScope(null, store, me),
      homeAssetsScope("token", { ...store, currentStoreId: null }, me),
      homeAssetsScope("token", store, null),
      homeAssetsScope("token", store, { ...me, memberships: [] }),
      homeAssetsScope("token", { ...store, currentStoreId: "foreign" }, me),
    ]) {
      expect(absent).toBeNull();
      const h = setup(absent);
      await h.resource.prepare(async () => undefined);
      await h.resource.refresh();
      expect(h.api.demands).not.toHaveBeenCalled();
      expect(h.api.summary).not.toHaveBeenCalled();
    }
    const member = me.memberships[0]!;
    const variants = [
      homeAssetsScope("new-token", store, me),
      homeAssetsScope("token", { ...store, contextRev: 2 }, me),
      homeAssetsScope("token", { ...store, currentStoreId: member.stores[1]!.storeId }, me),
      ...[
        { ...member, role: "clerk" as const },
        { ...member, memberId: "changed" },
        { ...member, entity: { ...member.entity, entityId: "changed" } },
        { ...member, stores: member.stores.slice(0, 1) },
      ].map((membership) => homeAssetsScope("token", store, { ...me, memberships: [membership] })),
      null,
    ];
    expect(
      homeAssetsScope("token", store, {
        ...me,
        memberships: [{ ...member, stores: [...member.stores].reverse() }],
      }),
    ).toBe(key);
    for (const changed of variants) {
      expect(changed).not.toBe(key);
      for (const failure of [false, true]) {
        const h = setup(key),
          demands = deferred<DemandPage>(),
          summary = deferred<AssetSummary>();
        h.api.demands.mockReturnValueOnce(demands.promise);
        h.api.summary.mockReturnValueOnce(summary.promise);
        const pending = h.resource.refresh();
        h.scope(changed);
        h.resource.dispose();
        if (failure) {
          demands.reject(new Error("private"));
          summary.reject(new Error("private"));
        } else {
          demands.resolve(homeAssetDemands);
          summary.resolve(assetSummary);
        }
        await pending;
        expect(h.resource.snapshot()).toMatchObject({
          demands: null,
          summary: null,
          demandsLoading: false,
          summaryLoading: false,
          demandsError: null,
          summaryError: null,
        });
      }
    }
    const h = setup(),
      start = deferred<void>();
    const pending = h.resource.prepare(() => start.promise);
    h.resource.suspend();
    expect(h.api.demands).not.toHaveBeenCalled();
    h.resource.resume();
    await h.resource.prepare(async () => undefined);
    expect(h.api.demands).toHaveBeenCalledTimes(1);
    expect(h.resource.snapshot()).toMatchObject({
      demands: homeAssetDemands,
      summary: assetSummary,
      demandsLoading: false,
      summaryLoading: false,
    });
    start.resolve();
    await pending;
    expect(h.api.demands).toHaveBeenCalledTimes(1);
    expect(h.resource.snapshot()).toMatchObject({
      demands: homeAssetDemands,
      summary: assetSummary,
      demandsLoading: false,
      summaryLoading: false,
    });
    h.resource.dispose();
    h.resource.resume();
    await h.resource.prepare(async () => undefined);
    expect(h.api.demands).toHaveBeenCalledTimes(2); // StrictMode setup 可重新激活本实例。
  });
  it("需求／摘要失败分别明确恢复不伪造零；新读取 busy 不被旧成功、错误或 finally 解除", async () => {
    const h = setup();
    h.api.summary.mockRejectedValueOnce(
      new ApiError({ error: "NOT_A_MEMBER", status: 403, requestId: "test", message: "secret" }),
    );
    await h.resource.refresh();
    expect(h.resource.snapshot()).toMatchObject({
      demands: homeAssetDemands,
      summary: null,
      summaryError: "门店权限已变化，请重新选择门店",
    });
    expect(h.resource.snapshot().summaryError).not.toContain("secret");
    h.api.demands.mockRejectedValueOnce(new Error("signed-secret"));
    await h.resource.refresh();
    expect(h.resource.snapshot()).toMatchObject({
      demands: null,
      summary: assetSummary,
      summaryError: null,
    });
    expect(h.resource.snapshot().demandsError).not.toContain("secret");
    await h.resource.refresh();
    expect(h.resource.snapshot()).toMatchObject({ demandsError: null, summaryError: null });
    for (const failure of [false, true]) {
      const oldDemand = deferred<DemandPage>(),
        oldSummary = deferred<AssetSummary>(),
        freshDemand = deferred<DemandPage>(),
        freshSummary = deferred<AssetSummary>();
      h.api.demands.mockReturnValueOnce(oldDemand.promise).mockReturnValueOnce(freshDemand.promise);
      h.api.summary
        .mockReturnValueOnce(oldSummary.promise)
        .mockReturnValueOnce(freshSummary.promise);
      const first = h.resource.refresh(),
        second = h.resource.refresh();
      if (failure) {
        oldDemand.reject(new Error("private"));
        oldSummary.reject(new Error("private"));
      } else {
        oldDemand.resolve(homeAssetDemands);
        oldSummary.resolve(assetSummary);
      }
      await first;
      expect(h.resource.snapshot()).toMatchObject({
        demandsLoading: true,
        summaryLoading: true,
        demands: null,
        summary: null,
        demandsError: null,
        summaryError: null,
      });
      freshDemand.resolve({ items: [], hasMore: false, nextCursor: null });
      freshSummary.resolve({ ...assetSummary, adoptedCount: 1 });
      await second;
      expect(h.resource.snapshot()).toMatchObject({
        demandsLoading: false,
        summaryLoading: false,
        demands: { items: [] },
        summary: { adoptedCount: 1 },
      });
    }
    const late = deferred<DemandPage>(),
      listener = vi.fn();
    h.api.demands.mockReturnValueOnce(late.promise);
    const off = h.resource.subscribe(listener),
      pending = h.resource.refresh();
    off();
    const calls = listener.mock.calls.length;
    h.resource.suspend();
    late.reject(new Error("private"));
    await pending;
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(h.resource.snapshot()).toMatchObject({
      demands: null,
      summary: null,
      demandsError: null,
    });
  });
});
