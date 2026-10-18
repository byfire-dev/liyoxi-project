import { describe, expect, it } from "vitest";
import { searchPage } from "../../../../shots/search-fixtures";
import type { SearchCard } from "./api";
import { highlight, mergeSearchPage } from "./model";

describe("搜索实际展示事实", () => {
  it("安全高亮保持原文/空格/中点/Unicode，未匹配字段不涂色", () => {
    const text = "新😀· 生 活<剧>";
    const parts = highlight(text, "😀生活", true);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.filter((p) => p.hit)).toEqual([{ text: "😀· 生 活", hit: true }]);
    expect(highlight("<剧>", "<剧>", false)).toEqual([{ text: "<剧>", hit: false }]);
    expect(highlight("都市", "都市生活", true, true)).toEqual([{ text: "都市", hit: true }]);
  });
  it.each(["owner", "clerk", "guest"] as const)(
    "%s续页去重保留实际顺序/匹配字段/价格，不重算",
    (role) => {
      const first = searchPage(role, { ids: [2, 1], hasMore: true });
      const next = searchPage(role, { ids: [1, 3], fields: ["cast"] });
      const result = mergeSearchPage(first, next);
      const items: SearchCard[] = result.items;
      expect(items.map((i) => i.dramaId)).toEqual([
        first.items[0]!.dramaId,
        first.items[1]!.dramaId,
        next.items[1]!.dramaId,
      ]);
      expect(result.items[1]).toEqual(first.items[1]);
      expect(result.items[2]!.matchedFields).toEqual(["cast"]);
      expect(items.every((i) => "discountedPoints" in i)).toBe(role === "owner");
      expect(result.hasMore).toBe(false);
    },
  );
  it("身份变化不合并老板字段；fallback事实和封顶数量来自下一服务器响应", () => {
    const next = { ...searchPage("clerk", { mode: "industry_fallback" }), totalApprox: 999 };
    expect(mergeSearchPage(searchPage("owner"), next)).toBe(next);
    expect(next.fallbackIndustry?.name).toBe("餐饮");
    expect(next.items.every((item) => !("discountedPoints" in item))).toBe(true);
  });
});
