import { describe, expect, it } from "vitest";
import { matchedFields, normalizeSearch } from "./search.js";
const genres = new Map([
  ["G01", "都市"],
  ["G02", "喜剧"],
]);
describe("目录三字段匹配", () => {
  it("统一去空白与间隔点，空关键词不会全匹配", () => {
    expect(normalizeSearch(" 都 市·喜剧\n")).toBe("都市喜剧");
    expect(
      matchedFields({ title: "都市", genreCodes: ["G01"], castNames: "某人" }, " · ", genres),
    ).toEqual([]);
  });
  it("title优先且三个真实字段同时保留", () => {
    expect(
      matchedFields(
        { title: "都市·故事", genreCodes: ["G01"], castNames: "都市演员" },
        "都 市",
        genres,
      ),
    ).toEqual(["title", "genre", "cast"]);
  });
  it("题材双向包含，未知题材不凭编码命中", () => {
    const row = { title: "店里", genreCodes: ["G01", "disabled"], castNames: null };
    expect(matchedFields(row, "都市爱情", genres)).toEqual(["genre"]);
    expect(matchedFields(row, "都", genres)).toEqual(["genre"]);
    expect(matchedFields(row, "G01", genres)).toEqual([]);
  });
  it("主演包含，剧名与主演不反向包含", () => {
    const row = { title: "巷口", genreCodes: [], castNames: "张·三、李四" };
    expect(matchedFields(row, "张三", genres)).toEqual(["cast"]);
    expect(matchedFields(row, "巷口商店", genres)).toEqual([]);
  });
});
