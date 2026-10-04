import { describe, expect, it } from "vitest";

import { antdTheme, fontFamilySerif } from "../src/design/generated/antd-theme.js";
import { paths } from "./generate.js";
import { buildAntdThemeToken, THEME_TOKEN_MAP } from "./lib/antd-theme.js";
import { firstTable, specSection } from "./lib/spec.js";
import { readTokens, tokenAt } from "./lib/tokens.js";

const tokens = readTokens(paths.tokens);
const theme: Record<string, string | number | boolean> = antdTheme.token;

/** 规范 第 5.4 节全局主题表：变量名 → 取值。一行里用“/”并列的逐个拆开；只写一个值的，几个变量同值 */
function specTheme(): Map<string, string | number | boolean> {
  const expected = new Map<string, string | number | boolean>();
  for (const [nameCell = "", valueCell = ""] of firstTable(
    specSection("### 5.4 Ant Design 主题"),
  )) {
    const names = nameCell.split(" / ").map((name) => name.replaceAll("`", ""));
    const values = valueCell
      .replace(/（.*）$/, "")
      .split(" / ")
      .map((value) => value.trim().replaceAll("`", ""));
    names.forEach((name, index) => {
      const raw = values.length === 1 ? values[0] : values[index];
      if (raw === undefined) throw new Error(`规范 第 5.4 节：${name} 没有对应的取值`);
      if (raw === "family-sans 的值") {
        expected.set(name, tokenAt(tokens, "shared.font.family-sans").value);
      } else if (raw === "true" || raw === "false") expected.set(name, raw === "true");
      else if (/^\d+$/.test(raw)) expected.set(name, Number(raw));
      else expected.set(name, raw);
    });
  }
  return expected;
}

describe("后台主题（规范 第 5.4 节）", () => {
  const expected = specTheme();

  it("规范的表读得出来", () => {
    expect(expected.size).toBeGreaterThan(40);
    expect(expected.get("wireframe")).toBe(false);
  });

  it("表里的每一项都在主题对象里，取值逐项相等；没有表外的项", () => {
    for (const [name, value] of expected) expect(theme[name], name).toBe(value);
    expect(Object.keys(theme).sort()).toEqual([...expected.keys()].sort());
  });

  it("colorTextBase 与 colorText 都设了；全局字号是 14，不是 13", () => {
    expect(theme.colorTextBase).toBe(theme.colorText);
    expect(theme.fontSize).toBe(14);
  });

  it("衬线字体不进主题，另出一个变量", () => {
    const serif = tokenAt(tokens, "shared.font.family-serif").value;
    expect(fontFamilySerif).toBe(serif);
    expect(Object.values(theme)).not.toContain(serif);
  });

  it("取值来自 tokens.json：每一项都指到一个样式变量，生成物与现算的一致", () => {
    for (const [name, path] of THEME_TOKEN_MAP) {
      expect(() => tokenAt(tokens, path), name).not.toThrow();
    }
    expect(theme).toEqual(buildAntdThemeToken(tokens));
  });
});
