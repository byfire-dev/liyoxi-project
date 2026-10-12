import { describe, expect, it, vi } from "vitest";
import type { RequestLayer } from "@/lib/request";
import { assetCard, assetDetail, assetPage, assetSummary } from "../../../../shots/asset-fixtures";
import { assetModerationLabel, assetTitle, createAssetApi } from "./api";

describe("素材只读 API", () => {
  it.each([
    ["none", "不审或未开始"],
    ["pending", "审核中"],
    ["pass", "审核通过"],
    ["review", "可疑待人工"],
    ["block", "已拦截，请替换文件"],
    ["future_state", "审核状态待确认"],
  ])("内容安全 %s 显示契约含义或安全回退", (state, label) => {
    expect(assetModerationLabel(state)).toBe(label);
  });
  it("同一筛选透传三 GET，summary 不带分页与类型，游标和 id 完整编码", async () => {
    const calls: string[] = [];
    const send: RequestLayer["request"] = async <T>(path: string): Promise<T> => {
      calls.push(path);
      return (
        path.includes("summary")
          ? assetSummary
          : path.includes("/a%2Fb")
            ? assetDetail()
            : assetPage()
      ) as T;
    };
    const api = createAssetApi(send);
    const filters = {
      status: "ready,adopted",
      tag: "中文+标签",
      q: "门店&咖啡",
      uploader: "me" as const,
    };
    expect(await api.list(filters, "image", "a/b+中文")).toEqual(assetPage());
    expect(await api.summary(filters)).toEqual(assetSummary);
    expect(await api.detail("a/b")).toEqual(assetDetail());
    const list = new URL(calls[0]!, "https://local"),
      summary = new URL(calls[1]!, "https://local");
    expect(Object.fromEntries(list.searchParams)).toEqual({
      ...filters,
      tab: "image",
      limit: "20",
      sort: "-createdAt",
      cursor: "a/b+中文",
    });
    expect(Object.fromEntries(summary.searchParams)).toEqual(filters);
    expect(calls[2]).toBe("/m/store-assets/a%2Fb");
  });
  it("空筛选不发送空 query；请求失败原样交控制器处理", async () => {
    const failure = new Error("private");
    const send = vi.fn<(path: string) => Promise<never>>().mockRejectedValue(failure);
    const api = createAssetApi(<T>(path: string): Promise<T> => send(path));
    await expect(api.summary({ q: undefined })).rejects.toBe(failure);
    expect(send).toHaveBeenCalledExactlyOnceWith("/m/store-assets/summary");
  });
  it.each(["image", "video", "recording", "audio", "document", "text"] as const)(
    "%s 标题只依据实际类型数量时长回退",
    (type) => {
      const card = { ...assetCard(2, type), title: null };
      expect(assetTitle(card)).not.toContain("null");
      expect(assetTitle({ ...card, title: "原始标题" })).toBe("原始标题");
      expect(assetTitle(card)).toContain(
        type === "text" ? "文字记录" : card.durationMs ? "12秒" : "2份",
      );
    },
  );
});
