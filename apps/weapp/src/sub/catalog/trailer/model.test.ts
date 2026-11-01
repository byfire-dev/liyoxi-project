import { describe, expect, it, vi } from "vitest";
import type { DramaDetail, DramaPage } from "@/stores/catalog";
import { catalogCard, catalogConfig } from "../../../../shots/catalog-fixtures";
import { trailerDetail } from "../../../../shots/trailer-fixtures";
import { createTrailerFeed, trailerShare } from "./model";

const page = (ids: number[], more = false): DramaPage => ({
  viewerRole: "owner",
  viewerPlan: null,
  items: ids.map(catalogCard),
  hasMore: more,
  nextCursor: more ? "opaque+/cursor=" : null,
});
function setup(first = page([1, 2]), initiallyEnabled = true) {
  let scope = "owner:store:1",
    enabled = initiallyEnabled;
  const api = {
    config: vi.fn(async () => catalogConfig),
    list: vi.fn(async (_query: unknown): Promise<DramaPage> => first),
    detail: vi.fn(async (id: string): Promise<DramaDetail> => trailerDetail(Number(id.slice(-3)))),
  };
  const model = createTrailerFeed({ api, scope: () => scope, enabled: () => enabled });
  return {
    model,
    api,
    switchScope: () => {
      scope = "clerk:store:2";
    },
    disable: () => {
      enabled = false;
    },
  };
}
describe("预告片默认列表与当前剧边界", () => {
  it("feed关闭时start、retry和next均不读取配置、列表或详情", async () => {
    const { model, api } = setup(page([1]), false);
    await model.start();
    await model.retry();
    await model.next();
    expect(api.config).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
    expect(api.detail).not.toHaveBeenCalled();
  });
  it("feed在列表请求中关闭后丢弃结果，不再串联详情或接受重试", async () => {
    const { model, api, disable } = setup();
    let resolve!: (value: DramaPage) => void;
    api.list.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const run = model.start();
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    disable();
    resolve(page([1]));
    await run;
    await model.retry();
    await model.next();
    expect(model.snapshot().page).toBeNull();
    expect(api.detail).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
  it("固定默认排序和20条，只读取当前详情；下一部按原列表顺序读取", async () => {
    const { model, api } = setup();
    await model.start();
    expect(api.list).toHaveBeenCalledExactlyOnceWith({
      sort: catalogConfig.defaultSort,
      limit: 20,
    });
    expect(api.detail).toHaveBeenCalledExactlyOnceWith(catalogCard(1).dramaId);
    await model.next();
    expect(api.detail.mock.calls.map(([id]) => id)).toEqual([
      catalogCard(1).dramaId,
      catalogCard(2).dramaId,
    ]);
    expect(model.snapshot().detail?.trailer).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
  it("续页去重且单页无新ID直接要求刷新，重复点击不递归扫描", async () => {
    const { model, api } = setup(page([1], true));
    api.list.mockResolvedValueOnce(page([1], true)).mockResolvedValueOnce(page([1], true));
    await model.start();
    await model.next();
    expect(model.snapshot()).toMatchObject({
      needsRefresh: true,
      nextError: "本页没有新的短剧，请刷新列表后重试",
    });
    await model.next();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.detail).toHaveBeenCalledTimes(1);
  });
  it("下一页失败保留原游标重试，重复ID不重排且只取新增第一部详情", async () => {
    const { model, api } = setup();
    api.list
      .mockResolvedValueOnce(page([1], true))
      .mockRejectedValueOnce(new Error("离线"))
      .mockResolvedValueOnce(page([1, 2]));
    await model.start();
    await model.next();
    await model.next();
    expect(api.list.mock.calls.slice(1)).toEqual([
      [{ sort: catalogConfig.defaultSort, limit: 20, cursor: "opaque+/cursor=" }],
      [{ sort: catalogConfig.defaultSort, limit: 20, cursor: "opaque+/cursor=" }],
    ]);
    expect(model.snapshot().page?.items.map((item) => item.dramaId)).toEqual([
      catalogCard(1).dramaId,
      catalogCard(2).dramaId,
    ]);
    expect(model.snapshot().detail?.dramaId).toBe(catalogCard(2).dramaId);
  });
  it.each(["hide", "scope", "dispose", "feed"])("%s废弃当前详情迟到结果", async (reason) => {
    const { model, api, switchScope, disable } = setup();
    let resolve!: (detail: DramaDetail) => void;
    api.detail.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const run = model.start();
    await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(1));
    if (reason === "hide") model.hide();
    else if (reason === "dispose") model.dispose();
    else if (reason === "feed") disable();
    else switchScope();
    resolve(trailerDetail());
    await run;
    expect(model.snapshot().detail).toBeNull();
  });
  it("分享只带当前剧编号和名称，不包含门店或签名地址", () => {
    const detail = trailerDetail();
    expect(trailerShare(detail)).toEqual({
      title: `《${detail.title}》｜狸有戏`,
      path: `/sub/catalog/detail/index?dramaId=${encodeURIComponent(detail.dramaId)}`,
    });
    expect(trailerShare(null).path).toBe("/pages/mall/index");
  });
});
