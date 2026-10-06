// 包级自测：导出自测与两条静态扫描（任务书 W0-11 第 7 节验收第 8、9 条）。
//
//   1. 导出自测：按包名逐个 import package.json 的 exports 里的每个子路径，都成功。
//   2. 纯度扫描：这些子路径可达的源文件不 import node:、react、zod，不用 DOM 与 Node 全局，
//      不用 Date 的本地时间方法；time 与 format 子路径另外不用 Intl、不用 BigInt（小程序可引）。
//   3. 只有一个取整函数：除取整文件外，src 下没有 Math.round、toFixed、parseFloat；
//      管钱的几个目录里没有小数字面量。
//
// 扫描走语法树（用根目录装的 typescript），注释与字符串里提到这些名字不算。
// 小程序经 Taro 构建能不能引，由 W0-27a 验；这里给的是静态证据。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const srcRoot = join(packageRoot, "src");
const requireFromHere = createRequire(import.meta.url);

/** exports 的一项：直接写文件，或按条件（types、default）写 */
type ExportTarget = string | { types?: string; default?: string };
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, ExportTarget>;
};
const subpaths = Object.entries(manifest.exports).map(([subpath, target]) => ({
  subpath,
  target,
  file: typeof target === "string" ? target : (target.default ?? ""),
}));
const isScript = (file: string): boolean => /\.[cm]?tsx?$/.test(file);
/** 不随包给到使用方的文件：测试与脚本。口径同 .dependency-cruiser.cjs 的 shared-no-node */
const isNotShipped = (file: string): boolean =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/(?:test|scripts)\//.test(file);
const specifierOf = (subpath: string): string =>
  subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
const rel = (file: string): string => relative(packageRoot, file);

// ---------- 扫描器 ----------

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** 文件里出现的全部模块说明符：import、export from、import()、require()、import type */
function importSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const [first] = node.arguments;
      if ((isImport || isRequire) && first && ts.isStringLiteralLike(first)) found.push(first.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteralLike(literal)) found.push(literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
    }
  });
  return found;
}

/** 标识符是不是只当属性名、成员名用（x.name、{ name: 1 }、interface 的成员名） */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  // 解构 { process: local }：冒号前是属性名；local 是新声明的变量，照样算用到
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name === node
  );
}

/** 文件里当变量用到的标识符（不含属性名） */
function identifiersUsed(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(source, (node) => {
    if (ts.isIdentifier(node) && !isMemberName(node)) names.add(node.text);
  });
  return names;
}

/** 文件里访问过的属性名：x.name 里的 name */
function propertiesAccessed(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(source, (node) => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      names.add(node.argumentExpression.text);
    }
  });
  return names;
}

const NODE_GLOBALS = [
  "process",
  "Buffer",
  "require",
  "__dirname",
  "__filename",
  "global",
  "setImmediate",
];
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "XMLHttpRequest",
];
/** globalThis 能绕过上面两张表；wx 是小程序的全局对象，纯函数里同样不该出现 */
const OTHER_GLOBALS = ["globalThis", "wx"];
const FORBIDDEN_PACKAGES = ["react", "react-dom", "zod", "@hono/zod-openapi"];
/** Date 的本地时间方法：结果随运行机器的时区变。要用 ../time 的函数或带 UTC 的方法 */
const LOCAL_TIME_METHODS = [
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTimezoneOffset",
  "getYear",
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "toDateString",
  "toTimeString",
];
const LOCALE_METHODS = [
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "localeCompare",
];

/** 纯度：返回违规说明，空数组即通过 */
function purityViolations(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const violations: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    const packageName = specifier.split("/")[0] ?? specifier;
    const scoped = specifier.split("/").slice(0, 2).join("/");
    if (specifier.startsWith("node:") || isBuiltin(specifier)) {
      violations.push(`import Node 内置模块 ${specifier}`);
    } else if (FORBIDDEN_PACKAGES.includes(packageName) || FORBIDDEN_PACKAGES.includes(scoped)) {
      violations.push(`import ${specifier}`);
    } else if (!specifier.startsWith(".") && scoped !== "@liyoxi/contract") {
      violations.push(`import 了 contract 以外的包 ${specifier}`);
    }
  }
  const used = identifiersUsed(source);
  for (const name of [...NODE_GLOBALS, ...DOM_GLOBALS, ...OTHER_GLOBALS]) {
    if (used.has(name)) violations.push(`用了全局对象 ${name}`);
  }
  const accessed = propertiesAccessed(source);
  for (const name of LOCAL_TIME_METHODS) {
    if (accessed.has(name)) violations.push(`用了 Date 的本地时间方法 ${name}`);
  }
  walk(source, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments?.length ?? 0) >= 2
    ) {
      violations.push("用了按本地时间构造的 new Date(年, 月, …)");
    }
  });
  return violations;
}

/** time 与 format 子路径另加的两条：不用 Intl 与按区域设置的方法；不用 BigInt */
function weappSafeViolations(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const violations: string[] = [];
  const used = identifiersUsed(source);
  if (used.has("Intl")) violations.push("用了 Intl");
  if (used.has("BigInt")) violations.push("用了 BigInt");
  const accessed = propertiesAccessed(source);
  for (const name of LOCALE_METHODS) {
    if (accessed.has(name)) violations.push(`用了按区域设置的方法 ${name}`);
  }
  walk(source, (node) => {
    if (ts.isBigIntLiteral(node)) violations.push(`用了 BigInt 字面量 ${node.text}`);
    if (node.kind === ts.SyntaxKind.BigIntKeyword) violations.push("用了 bigint 类型");
  });
  return violations;
}

/** 取整：Math.round、toFixed、parseFloat */
function roundingViolations(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const violations: string[] = [];
  const accessed = propertiesAccessed(source);
  walk(source, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "round"
    ) {
      violations.push("用了 Math.round");
    }
  });
  if (accessed.has("toFixed")) violations.push("用了 toFixed");
  if (accessed.has("parseFloat") || identifiersUsed(source).has("parseFloat")) {
    violations.push("用了 parseFloat");
  }
  return violations;
}

/** 小数字面量：0.9、1.2、1e-2 这类。金额与积分只做整数运算 */
function decimalLiterals(fileName: string, text: string): string[] {
  const found: string[] = [];
  const source = parse(fileName, text);
  walk(source, (node) => {
    // node.text 是换算后的值（1e-2 是 "0.01"）；报告里写源码里的原样
    if (ts.isNumericLiteral(node) && !Number.isInteger(Number(node.text))) {
      found.push(node.getText(source));
    }
  });
  return found;
}

// ---------- 文件清单 ----------

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return isScript(entry.name) ? [full] : [];
  });
}

/** 相对说明符 → 源文件：仓库里相对导入写 .js 后缀，实际文件是 .ts */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && isScript(candidate));
}

/** 从入口文件出发，沿相对导入能到的全部源文件 */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = parse(file, readFileSync(file, "utf8"));
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(file, specifier);
      if (target === undefined) throw new Error(`${rel(file)}：找不到 ${specifier}`);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

const scriptEntries = subpaths
  .filter(({ file }) => isScript(file))
  .map(({ subpath, file }) => ({ subpath, entry: join(packageRoot, file) }));

const report = (files: readonly string[], check: (file: string, text: string) => string[]) =>
  files.flatMap((file) =>
    check(file, readFileSync(file, "utf8")).map((violation) => `${rel(file)}：${violation}`),
  );

// ---------- 用例 ----------

describe("导出自测：按包名逐个 import exports 里的每个子路径", () => {
  it("本包的子路径都在：入口、alloc、assert、format/money、period、pricing、time、workcal", () => {
    expect(Object.keys(manifest.exports)).toEqual(
      expect.arrayContaining([
        ".",
        "./alloc",
        "./assert",
        "./format/money",
        "./period",
        "./pricing",
        "./time",
        "./workcal",
        "./uploads",
      ]),
    );
  });

  it.each(subpaths)("$subpath", async ({ subpath, target, file }) => {
    const resolved = requireFromHere.resolve(specifierOf(subpath));
    expect(rel(resolved)).toBe(rel(join(packageRoot, file)));
    expect(existsSync(resolved)).toBe(true);
    // 不是脚本的导出（如别的包以后加的样式文件）只查解析得到、文件在；脚本要真的 import 得进来
    if (!isScript(file)) return;
    // 源码包，没有构建：types 与 default 指向同一个文件
    if (typeof target !== "string") expect(target.types).toBe(target.default);
    const loaded = (await import(specifierOf(subpath))) as Record<string, unknown>;
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
  });

  it("包入口把本包的各子路径原样再导出", async () => {
    const root = (await import(manifest.name)) as Record<string, unknown>;
    for (const name of [
      "alloc",
      "assert",
      "format/money",
      "period",
      "pricing",
      "time",
      "workcal",
    ]) {
      const loaded = (await import(`${manifest.name}/${name}`)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(loaded)) {
        expect(root[key], `${name} 的 ${key}`).toBe(value);
      }
    }
  });
});

describe("纯度扫描：子路径可达的源文件", () => {
  it.each(scriptEntries)(
    "$subpath：不 import node:、react、zod，不用 DOM 与 Node 全局",
    ({ entry }) => {
      const files = reachableFrom(entry);
      expect(files.length).toBeGreaterThan(0);
      // 可达的都是 src 下的文件，且不是测试与脚本
      for (const file of files) {
        expect(rel(file)).toMatch(/^src\//);
        expect(isNotShipped(file), rel(file)).toBe(false);
      }
      expect(report(files, purityViolations)).toEqual([]);
    },
  );

  // 类型检查带着 node 类型，lint 也认 Node 全局：源码里直接写 process.env、Buffer 两边都不报。
  // 所以没有被任何子路径引到的文件也一并扫，不留死角。
  it("src 下的全部源码（测试与脚本除外）都过纯度扫描，哪怕没有被任何子路径引到", () => {
    const shipped = listSources(srcRoot).filter((file) => !isNotShipped(file));
    expect(shipped.length).toBeGreaterThanOrEqual(9);
    expect(report(shipped, purityViolations)).toEqual([]);
  });

  it.each(scriptEntries.filter(({ subpath }) => /^\.\/(time|format)(\/|$)/.test(subpath)))(
    "$subpath：不用 Intl 的时区数据，不用 BigInt（小程序可引）",
    ({ entry }) => {
      expect(report(reachableFrom(entry), weappSafeViolations)).toEqual([]);
    },
  );

  it("time 与 format/money 都在上一条的范围里", () => {
    const covered = scriptEntries
      .map(({ subpath }) => subpath)
      .filter((subpath) => /^\.\/(time|format)(\/|$)/.test(subpath));
    expect(covered).toEqual(expect.arrayContaining(["./time", "./format/money"]));
  });
});

describe("只有一个取整函数", () => {
  const ROUND_FILE = join(srcRoot, "pricing/round.ts");
  const sources = listSources(srcRoot);

  it("取整文件在，且 src 下扫到的文件不少于本包写的那些", () => {
    expect(sources).toContain(ROUND_FILE);
    expect(sources.length).toBeGreaterThanOrEqual(10);
  });

  it("除取整文件外，src 下（含测试）没有 Math.round、toFixed、parseFloat", () => {
    const others = sources.filter((file) => file !== ROUND_FILE);
    expect(report(others, roundingViolations)).toEqual([]);
  });

  it("管钱的目录（pricing、period、alloc、format/money）里没有小数字面量", () => {
    const moneyFiles = sources.filter(
      (file) =>
        /^src\/(pricing|period|alloc)\/|^src\/format\/money\.ts$/.test(rel(file)) &&
        !isNotShipped(file),
    );
    expect(moneyFiles.length).toBeGreaterThanOrEqual(5);
    const found = moneyFiles.flatMap((file) =>
      decimalLiterals(file, readFileSync(file, "utf8")).map(
        (literal) => `${rel(file)}：${literal}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe("扫描器自测：反例必须被扫出来，注释与字符串不算", () => {
  it.each([
    { name: "import node:fs", code: `import { readFileSync } from "node:fs";` },
    { name: "import 不带前缀的内置模块", code: `import path from "path";` },
    { name: "import react", code: `import { useMemo } from "react";` },
    { name: "import zod", code: `import { z } from "zod";` },
    { name: "import zod 的子路径", code: `export { z } from "zod/v4";` },
    { name: "import @hono/zod-openapi", code: `import { z } from "@hono/zod-openapi";` },
    { name: "只引类型也算", code: `import type { ZodType } from "zod";` },
    { name: "动态 import", code: `export const load = () => import("node:crypto");` },
    { name: "import 别的工作区包", code: `import { db } from "@liyoxi/db";` },
    { name: "process.env", code: `export const env = process.env.NODE_ENV;` },
    { name: "Buffer", code: `export const b = Buffer.from("a");` },
    { name: "window", code: `export const w = window.innerWidth;` },
    { name: "document", code: `export const d = typeof document;` },
    { name: "localStorage", code: `localStorage.setItem("k", "v");` },
    { name: "fetch", code: `export const r = fetch("/x");` },
    { name: "globalThis", code: `export const g = globalThis;` },
    { name: "Date 的本地时间方法", code: `export const h = (d: Date) => d.getHours();` },
    { name: "按本地时间构造日期", code: `export const d = new Date(2026, 0, 1);` },
  ])("纯度反例：$name", ({ code }) => {
    expect(purityViolations("bad.ts", code)).not.toEqual([]);
  });

  it("纯度正例：相对导入、contract 的子路径、UTC 方法、同名的属性都放行", () => {
    const code = `
      // 注释里提到 process.env、window、node:fs、zod 不算
      import { addDays } from "../time/index.js";
      import type { ErrorCode } from "@liyoxi/contract/errors";
      export const note = "字符串里的 Buffer、document 与 Math.round 不算";
      export const utc = (d: Date) => d.getUTCHours() + new Date(d.getTime()).getUTCDate();
      export const lot = { process: 1, window: addDays("2026-01-01", 1) };
      export const read = (x: { fetch: number }) => x.fetch + lot.process;
    `;
    expect(purityViolations("good.ts", code)).toEqual([]);
    expect(roundingViolations("good.ts", code)).toEqual([]);
  });

  it.each([
    { name: "Intl", code: `export const f = new Intl.NumberFormat("zh-CN");` },
    { name: "toLocaleString", code: `export const s = (n: number) => n.toLocaleString();` },
    { name: "BigInt()", code: `export const b = BigInt(1);` },
    { name: "BigInt 字面量", code: `export const b = 1n;` },
    { name: "bigint 类型", code: `export type B = bigint;` },
  ])("小程序可引的反例：$name", ({ code }) => {
    expect(weappSafeViolations("bad.ts", code)).not.toEqual([]);
  });

  it.each([
    { name: "Math.round", code: `export const r = Math.round(1);` },
    { name: "toFixed", code: `export const s = (n: number) => n.toFixed(2);` },
    { name: "parseFloat", code: `export const n = parseFloat("1");` },
    { name: "Number.parseFloat", code: `export const n = Number.parseFloat("1");` },
  ])("取整反例：$name", ({ code }) => {
    expect(roundingViolations("bad.ts", code)).not.toEqual([]);
  });

  it("小数字面量反例：0.9、1e-2 扫得出来，整数与 10_000 不算", () => {
    expect(decimalLiterals("bad.ts", `export const r = 0.9 * 100 + 1e-2;`)).toEqual([
      "0.9",
      "1e-2",
    ]);
    expect(decimalLiterals("good.ts", `export const r = 10_000 + 1e3 + 0x10;`)).toEqual([]);
  });
});
