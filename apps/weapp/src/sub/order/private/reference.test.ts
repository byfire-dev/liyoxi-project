import { describe, expect, it, vi } from "vitest";
import type { RequestLayer, RequestOptions } from "@/lib/request";
import { canSubmitOrder, createOrderIntent } from "@/stores/order";
import { assetCard, assetId } from "../../../../shots/asset-fixtures";
import { AGREEMENT_ID, CHANNEL_ID, orderQuote } from "../../../../shots/order-fixtures";
import {
  createOrderReferenceApi,
  type OrderReferenceApi,
  type ReferencePage,
} from "./reference-api";
import { createOrderReferences } from "./reference-model";
vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
import { createOrderApi } from "./api";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const page = (numbers = [1, 2, 3], hasMore = false): ReferencePage => ({
  items: numbers.map((n) => assetCard(n)),
  hasMore,
  nextCursor: hasMore ? "opaque+/中文" : null,
});
function setup(ids?: string[]) {
  let scope: string | null = "token/member/entity/owner/store/rev1",
    locked = false;
  const api = {
    list: vi.fn<OrderReferenceApi["list"]>().mockResolvedValue(page()),
    byIds: vi.fn<OrderReferenceApi["byIds"]>().mockResolvedValue(page()),
  };
  const changed = vi.fn();
  const model = createOrderReferences({
    api,
    scope: () => scope,
    changed,
    ids,
    locked: () => locked,
  });
  return {
    model,
    api,
    changed,
    setScope: (value: string | null) => {
      scope = value;
    },
    lock: () => {
      locked = true;
    },
  };
}
describe("订单参考素材最小关键覆盖", () => {
  it("选择只传真实isSelectableAsReference与游标；按ID回显不混筛选和排序", async () => {
    const calls: string[] = [];
    const send: RequestLayer["request"] = async <T>(path: string): Promise<T> => {
      calls.push(path);
      return page() as T;
    };
    const api = createOrderReferenceApi(send);
    await api.list("opaque+/中文");
    await api.byIds([assetId(2), assetId(1)]);
    expect(Object.fromEntries(new URL(calls[0]!, "https://local").searchParams)).toEqual({
      isSelectableAsReference: "true",
      limit: "20",
      sort: "-createdAt",
      cursor: "opaque+/中文",
    });
    expect(Object.fromEntries(new URL(calls[1]!, "https://local").searchParams)).toEqual({
      ids: `${assetId(2)},${assetId(1)}`,
      limit: "20",
    });
  });
  it("仅按服务端bool选ID，上限9去重；需肖像授权仍可参考，非法/未知ID不触发意图", async () => {
    const h = setup();
    h.api.list.mockResolvedValueOnce({
      ...page([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      items: page([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).items.map((item, n) =>
        n === 0
          ? { ...item, isSelectableAsReference: false }
          : n === 1
            ? { ...item, usability: "need_portrait_auth", displayStatus: "need_portrait_auth" }
            : item,
      ),
    });
    await h.model.refresh();
    h.model.toggle(assetId(1));
    h.model.toggle("unknown");
    expect(h.changed).not.toHaveBeenCalled();
    for (let n = 2; n <= 11; n++) h.model.toggle(assetId(n));
    expect(h.model.snapshot().selected.map((item) => item.storeAssetId)).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9, 10].map(assetId),
    );
    expect(h.changed).toHaveBeenCalledTimes(9);
    h.model.toggle(assetId(2));
    h.model.toggle(assetId(11));
    expect(h.model.body()?.referenceStoreAssetIds).toHaveLength(9);
  });
  it("更多同步单飞、去重、失败保留已选和原cursor，只有实际用户选择才取下一页", async () => {
    const h = setup(),
      late = deferred<ReferencePage>();
    h.api.list.mockResolvedValueOnce(page([1, 2], true)).mockReturnValueOnce(late.promise);
    await h.model.refresh();
    h.model.toggle(assetId(1));
    expect(h.api.list).toHaveBeenCalledTimes(1);
    const first = h.model.more();
    await h.model.more();
    expect(h.api.list).toHaveBeenCalledTimes(2);
    late.reject(new Error("private signed URL"));
    await first;
    expect(h.model.snapshot().selected).toHaveLength(1);
    expect(h.model.snapshot().page?.items).toHaveLength(2);
    h.api.list.mockResolvedValueOnce(page([2, 3, 3]));
    await h.model.more();
    expect(h.api.list.mock.calls[2]).toEqual(h.api.list.mock.calls[1]);
    expect(h.model.snapshot().page?.items.map((item) => item.storeAssetId)).toEqual(
      [1, 2, 3].map(assetId),
    );
    expect(h.model.snapshot().moreError).toBeNull();
  });
  it("刷新仅更新已选可参考性；提交锁定后晚返回不改ID/key，只有用户移除才换意图", async () => {
    const h = setup();
    await h.model.refresh();
    h.model.toggle(assetId(1));
    h.model.toggle(assetId(2));
    let sequence = 0;
    const intent = createOrderIntent(() => `order:${++sequence}`),
      key = intent.current();
    h.changed.mockImplementation(() => {
      intent.changed();
    });
    const late = deferred<ReferencePage>();
    h.api.byIds.mockReturnValueOnce(late.promise);
    const read = h.model.refresh(),
      body = h.model.body();
    h.lock();
    late.resolve({ ...page([2]), items: [{ ...assetCard(2), isSelectableAsReference: false }] });
    await read;
    expect(h.api.byIds).toHaveBeenCalledWith([assetId(1), assetId(2)]);
    expect(h.model.body()).toEqual(body);
    expect(intent.current()).toBe(key);
    expect(h.model.snapshot().selected.every((item) => !item.isSelectableAsReference)).toBe(true);
    expect(h.changed).toHaveBeenCalledTimes(2);
    const explicit = setup();
    await explicit.model.refresh();
    explicit.model.toggle(assetId(1));
    explicit.api.byIds.mockResolvedValueOnce(page([]));
    await explicit.model.refresh();
    expect(explicit.model.body()?.referenceStoreAssetIds).toEqual([assetId(1)]);
    explicit.model.toggle(assetId(1));
    expect(explicit.model.body()).toEqual({});
    expect(explicit.changed).toHaveBeenCalledTimes(2);
  });
  it("完整scope变化/隐藏/卸载废弃迟到成功错误finally，旧选项不能交给新店", async () => {
    for (const outcome of ["success", "error"] as const) {
      const h = setup(),
        late = deferred<ReferencePage>();
      await h.model.refresh();
      h.model.toggle(assetId(1));
      h.api.list.mockReturnValueOnce(late.promise);
      const pending = h.model.refresh();
      h.setScope("token/otherMember/entity/clerk/otherStore/rev2");
      const frozen = h.model.snapshot();
      if (outcome === "success") late.resolve(page([99]));
      else late.reject(new Error("private"));
      await pending;
      expect(h.model.snapshot()).toBe(frozen);
      expect(h.model.body()).toBeNull();
      h.model.dispose();
    }
    const hidden = setup(),
      late = deferred<ReferencePage>();
    hidden.api.list.mockReturnValueOnce(late.promise);
    const pending = hidden.model.refresh();
    hidden.model.suspend();
    late.resolve(page([99]));
    await pending;
    expect(hidden.model.snapshot().page).toBeNull();
    hidden.model.resume();
    await Promise.resolve();
    await Promise.resolve();
    expect(hidden.model.snapshot().page?.items[0]?.storeAssetId).toBe(assetId(1));
    const last = setup(),
      result = deferred<ReferencePage>();
    last.api.list.mockReturnValueOnce(result.promise);
    const work = last.model.refresh();
    last.model.dispose();
    const frozen = last.model.snapshot();
    result.resolve(page([99]));
    await work;
    expect(last.model.snapshot()).toBe(frozen);
  });
  it("参考只附加create字段，保留原报价expect、同意校验和同键重试；订购同步闩锁住选择", async () => {
    const h = setup(),
      calls: [string, RequestOptions | undefined][] = [];
    const send: RequestLayer["request"] = async <T>(
      path: string,
      options?: RequestOptions,
    ): Promise<T> => {
      calls.push([path, options]);
      return null as T;
    };
    const api = createOrderApi(send);
    let sequence = 0;
    const intent = createOrderIntent(() => `order:${++sequence}`);
    expect(h.model.body()).toEqual({});
    await h.model.refresh();
    h.model.toggle(assetId(1));
    intent.changed();
    const body = {
      dramaIds: orderQuote.expect.items.map((item) => item.dramaId),
      isTopModel: false,
      channelAccountIds: [CHANNEL_ID],
      focusCodes: ["product"],
      agreementVersionId: AGREEMENT_ID,
      expect: orderQuote.expect,
      ...h.model.body(),
    };
    await api.create(body, intent.current());
    await api.create(body, intent.current());
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]?.[1]?.data).toMatchObject({
      expect: orderQuote.expect,
      referenceStoreAssetIds: [assetId(1)],
    });
    expect(canSubmitOrder(orderQuote, [CHANNEL_ID], ["product"], AGREEMENT_ID)).toBe(true);
    expect(canSubmitOrder(orderQuote, [CHANNEL_ID], ["product"], "stale")).toBe(false);
    h.lock();
    h.model.toggle(assetId(1));
    await h.model.refresh();
    expect(h.model.body()?.referenceStoreAssetIds).toEqual([assetId(1)]);
    expect(h.api.list).toHaveBeenCalledTimes(1);
  });
  it("详情只按订单真实ID回显，缺失素材不伪造卡片，不按当前可参考性隐藏历史引用", async () => {
    const ids = [assetId(2), assetId(99), assetId(1)],
      h = setup(ids);
    h.api.byIds.mockResolvedValueOnce({
      ...page([2, 1]),
      items: [{ ...assetCard(2), isSelectableAsReference: false }, assetCard(1)],
    });
    await h.model.refresh();
    expect(h.api.list).not.toHaveBeenCalled();
    expect(h.api.byIds).toHaveBeenCalledWith(ids);
    expect(h.model.snapshot().page?.items.map((item) => item.storeAssetId)).toEqual([
      assetId(2),
      assetId(1),
    ]);
    h.model.toggle(assetId(1));
    expect(h.model.snapshot().selected).toEqual([]);
  });
});
