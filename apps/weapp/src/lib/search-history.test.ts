import { describe, expect, it } from "vitest";
import type { KeyValueStorage } from "./platform";
import { createSearchHistory, normalizeKeyword, validKeyword } from "./search-history";
import { StorageKey } from "./storage";

function memory(initial: unknown = null) {
  const values = new Map<string, unknown>([[StorageKey.searchHistory, initial]]);
  const storage: KeyValueStorage = {
    get: <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
  return { history: createSearchHistory(storage), values };
}
describe("本机搜索历史", () => {
  it("归一中点和所有空白，按 Unicode 码点接受1–20字", () => {
    expect(normalizeKeyword(" 都市· 生\n活\t")).toBe("都市生活");
    expect(validKeyword("😀".repeat(20))).toBe(true);
    expect(validKeyword("😀".repeat(21))).toBe(false);
    expect(validKeyword(" · \n")).toBe(false);
  });
  it("同词置顶去重，最多10条；读写同一个已登记本地键", () => {
    const { history, values } = memory();
    for (let i = 0; i < 12; i++) history.remember(`关键词${i}`);
    expect(history.read()).toEqual(Array.from({ length: 10 }, (_, i) => `关键词${11 - i}`));
    history.remember("关键词 · 8");
    expect(history.read()).toEqual([
      "关键词8",
      "关键词11",
      "关键词10",
      "关键词9",
      "关键词7",
      "关键词6",
      "关键词5",
      "关键词4",
      "关键词3",
      "关键词2",
    ]);
    expect([...values.keys()]).toEqual([StorageKey.searchHistory]);
  });
  it("真实clear删除存储；无效词不写；损坏数据和超长项不回显", () => {
    const { history, values } = memory([null, 9, "😀".repeat(21), "生 活", "生活", ""]);
    expect(history.read()).toEqual(["生活"]);
    history.remember(" · ");
    expect(values.get(StorageKey.searchHistory)).toHaveLength(6);
    history.clear();
    expect(values.has(StorageKey.searchHistory)).toBe(false);
    expect(history.read()).toEqual([]);
    expect(memory({ invalid: true }).history.read()).toEqual([]);
  });
});
