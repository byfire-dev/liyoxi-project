// 静态扫描：从一个入口文件出发，沿相对路径的 import / export 走到底，列出可达的源文件与引到的包。
// 只给契约自测用（验收 6）。import type 也算：门禁 shared-no-zod、weapp-no-zod 把类型导入也计入可达性。
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ImportScan {
  /** 可达的源文件（绝对路径），含入口 */
  files: string[];
  /** 引到的非相对路径模块名，去重排序：包名、子路径、node: 内置模块 */
  packages: string[];
}

const PATTERNS = [
  // import … from "x"、export … from "x"（含 import type、export type、export *）
  /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g,
  // 只为副作用的 import "x"
  /\bimport\s*["']([^"']+)["']/g,
  // 动态 import("x") 与 require("x")
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** 相对路径的模块落到哪个源文件：按 NodeNext 的写法，.js 对应 .ts */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    resolve(base, "index.ts"),
  ];
  const found = candidates.find(
    (candidate) => /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(candidate),
  );
  if (!found) throw new Error(`${fromFile} 引的 ${specifier} 找不到对应的源文件`);
  return found;
}

export function importsReachableFrom(entryFile: string): ImportScan {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entryFile];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    const source = stripComments(readFileSync(file, "utf8"));
    for (const pattern of PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier));
        else packages.add(specifier);
      }
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() };
}
