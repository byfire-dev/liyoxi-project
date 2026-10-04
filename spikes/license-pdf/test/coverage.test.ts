import { describe, expect, it } from "vitest";

import { describeChar, MISSING_MARK, replaceUncovered } from "../src/coverage.ts";
import { registerFonts } from "../src/fonts.ts";
import { NBSP } from "../src/linebreak.ts";

const coverage = registerFonts();
const has = (char: string) => coverage.has(char.codePointAt(0) ?? 0);

describe("随附字体收了哪些字", () => {
  it("常用字、全角标点、西文都收了", () => {
    for (const char of "授权书，。、；：？！（）《》“”‘’…—·ABCxyz0123456789￥%") {
      expect(has(char), char).toBe(true);
    }
  });

  it("扩展 A 区与基本区的生僻字收了：䶮、龘、㙟", () => {
    for (const char of "䶮龘㙟䲟鱻麤") expect(has(char), char).toBe(true);
  });

  it("《通用规范汉字表》里落在扩展 B–E 区的字收了：𬌗、𫖯、𬭚", () => {
    for (const char of "𬌗𫖯𬭚𫓧𬬮𫚕") expect(has(char), char).toBe(true);
  });

  it("扩展 B 区的 𠮷 没收；表情符号没收", () => {
    expect(has("𠮷")).toBe(false);
    expect(has("😀")).toBe(false);
  });

  it("替代符号本身收了，不换行空格收了", () => {
    expect(has(MISSING_MARK)).toBe(true);
    expect(has(NBSP)).toBe(true);
  });
});

describe("缺字替换", () => {
  it("没收的字换成替代符号并记下来；收了的字不动", () => {
    const missing = new Set<string>();
    expect(replaceUncovered("𠮷野家😀官方号", coverage, missing)).toBe("〓野家〓官方号");
    expect([...missing].map(describeChar)).toEqual(["𠮷 U+20BB7", "😀 U+1F600"]);
  });
});
