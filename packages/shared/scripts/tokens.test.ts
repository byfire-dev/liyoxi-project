import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adminTokens, merchantTokens, sharedTokens } from "../src/design/generated/tokens.js";
import { paths } from "./generate.js";
import { parseTokens, readTokens, scssName, SIDES, type Side, type Token } from "./lib/tokens.js";

type Json = Record<string, unknown>;

const source = JSON.parse(readFileSync(paths.tokens, "utf8")) as Json;
const tokens = readTokens(paths.tokens);

/** 不经生成脚本，直接在 tokens.json 里数：带 $value 的对象就是一个变量 */
function countValues(node: unknown): number {
  if (typeof node !== "object" || node === null) return 0;
  if ("$value" in node) return 1;
  return Object.values(node).reduce<number>((sum, child) => sum + countValues(child), 0);
}

/** 读生成的 scss：变量名 → 取值 */
function readScss(side: Side): Map<string, string> {
  const text = readFileSync(join(paths.generated, `${side}.scss`), "utf8");
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("//")) continue;
    const match = /^(\$[a-z0-9-]+): (.+?);(?: \/\/ .*)?$/.exec(line);
    if (!match?.[1] || match[2] === undefined) throw new Error(`读不懂这一行：${line}`);
    expect(vars.has(match[1]), `${side}.scss 里 ${match[1]} 重复`).toBe(false);
    vars.set(match[1], match[2]);
  }
  return vars;
}

const bySection = (section: Token["section"]): Token[] =>
  tokens.filter((t) => t.section === section);

describe("变量全覆盖", () => {
  it("tokens.json 的每个变量都读到了，数量现数", () => {
    const total = countValues(source);
    expect(total).toBeGreaterThan(0);
    expect(tokens).toHaveLength(total);
    for (const section of ["shared", "merchant", "admin"] as const) {
      expect(bySection(section)).toHaveLength(countValues(source[section]));
    }
  });

  it.each(SIDES)("%s.scss 含 shared 与本端两段，变量名以 $lyx- 开头，数值逐个相等", (side) => {
    const vars = readScss(side);
    const expected = [...bySection("shared"), ...bySection(side)];
    expect(vars.size).toBe(expected.length);
    for (const token of expected) {
      const name = scssName(token);
      expect(name.startsWith("$lyx-")).toBe(true);
      expect(vars.get(name), name).toBe(String(token.value));
    }
  });

  it("一端的文件里没有另一端专有的变量", () => {
    const merchantOnly = bySection("merchant").map(scssName);
    const adminOnly = bySection("admin").map(scssName);
    const shared = new Set(bySection("shared").map(scssName));
    const merchantVars = readScss("merchant");
    const adminVars = readScss("admin");
    // 两端同名的专有变量（如各自的 border-strong）不算串段：各端文件里是各端的值
    for (const name of adminOnly) {
      if (!merchantOnly.includes(name)) expect(merchantVars.has(name), name).toBe(false);
    }
    for (const name of merchantOnly) {
      if (!adminOnly.includes(name)) expect(adminVars.has(name), name).toBe(false);
    }
    for (const name of [...merchantOnly, ...adminOnly]) expect(shared.has(name), name).toBe(false);
  });

  it("TS 常量与 tokens.json 逐个相等", () => {
    const generated: Record<string, Record<string, Record<string, string | number>>> = {
      shared: sharedTokens,
      merchant: merchantTokens,
      admin: adminTokens,
    };
    let count = 0;
    for (const [section, groups] of Object.entries(generated)) {
      for (const [group, entries] of Object.entries(groups)) {
        for (const [name, value] of Object.entries(entries)) {
          const raw = ((source[section] as Json)[group] as Json)[name] as Json;
          expect(value, `${section}.${group}.${name}`).toBe(raw.$value);
          count += 1;
        }
      }
    }
    expect(count).toBe(countValues(source));
  });
});

describe("读变量表", () => {
  it("缺 $value、缺某一段都报错，不生成半截", () => {
    expect(() => parseTokens("{}")).toThrow("shared");
    const broken = JSON.stringify({
      shared: { color: { primary: { $type: "color" } } },
      merchant: {},
      admin: {},
    });
    expect(() => parseTokens(broken)).toThrow("shared.color.primary");
  });
});
