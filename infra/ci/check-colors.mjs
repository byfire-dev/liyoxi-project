#!/usr/bin/env node
// “页面不写色值”检查（开发计划 第 10.1 节“页面”行；规范 第 6.1 节；CLAUDE.md 硬性规则 24）。
//
// 用法：node infra/ci/check-colors.mjs [--root <目录>] [--allowlist <文件>]   根脚本是 pnpm lint:colors
//   --root       到哪个目录下找 apps/；不给时是当前目录（仓库根）
//   --allowlist  白名单文件；不给时是本脚本旁边的 colors-allowlist.txt
// 口径：
//   1. 扫 apps/weapp/src、apps/admin/src、apps/portal/src 下的 .scss、.css、.ts、.tsx。
//   2. 写了十六进制色值（#RGB、#RGBA、#RRGGBB、#RRGGBBAA）、rgb()、rgba()、hsl()、hsla() 即失败，
//      并指出文件、行、列。颜色取样式变量或主题，状态色取状态字典（@liyoxi/shared 的 design 子路径）。
//   3. 注释里的不算。字符串、模板字符串、JSX 文本里的都算。
//   4. 放行两类：路径里带 /generated/ 的生成物；白名单里列的路径。
//      白名单一行一个：文件路径，或以 / 结尾的目录；# 开头是注释。初始为空（规范 第 1.6 节
//      “不进变量的颜色”用到时再加）。加条目属“放松”类门禁改动，走单独的 gate-change PR。
// 退出码：0 通过；1 有违规；2 用法或环境错误。
// 本脚本不引依赖，不解析语法，只认字符串与注释。已知的粗糙处：.ts、.tsx 里的正则字面量不单独识别，
// 里面带引号时后面的注释可能认不出来（多报）；里面带 // 时同一行的后半截会被当成注释（那半行不扫）。
// 页面代码里这两种写法少见，遇到时把正则单独放一行。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_DIRS = ["apps/weapp/src", "apps/admin/src", "apps/portal/src"];
const EXTENSIONS = [".scss", ".css", ".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);
const COLOR =
  /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgb|hsl)a?\s*\(/gi;

function fail(message) {
  console.error(`页面色值检查：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    allowlist: join(dirname(fileURLToPath(import.meta.url)), "colors-allowlist.txt"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--root" && value) options.root = resolve(value);
    else if (argv[i] === "--allowlist" && value) options.allowlist = resolve(value);
    else fail(`不认识的参数 ${argv[i]}。用法见本脚本开头的注释`);
    i += 1;
  }
  return options;
}

function readAllowlist(file) {
  if (!existsSync(file)) fail(`找不到白名单文件 ${file}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function listFiles(root, dir) {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return SKIP_DIRS.has(item.name) ? [] : listFiles(root, path);
      return EXTENSIONS.some((extension) => item.name.endsWith(extension)) ? [path] : [];
    });
}

/** 把注释换成等长的空格（换行保留），行号、列号不变。字符串原样留着 */
function blankComments(text, lineComments) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== char) {
        // 普通字符串不跨行：没闭合就到行尾为止（样式文件里的撇号不至于吞掉后面的内容）
        if (text[j] === "\n" && char !== "`") break;
        j += text[j] === "\\" ? 2 : 1;
      }
      i = j + 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (lineComments && char === "/" && next === "/" && text[i - 1] !== ":") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

const { root, allowlist } = parseArgs(process.argv.slice(2));
const allowed = readAllowlist(allowlist);
const isAllowed = (file) =>
  allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

const violations = [];
let scanned = 0;
let skipped = 0;

for (const file of SCAN_DIRS.flatMap((dir) => listFiles(root, dir))) {
  if (file.includes("/generated/") || isAllowed(file)) {
    skipped += 1;
    continue;
  }
  scanned += 1;
  const raw = readFileSync(join(root, file), "utf8");
  const rawLines = raw.split("\n");
  // .css 没有 // 注释
  blankComments(raw, !file.endsWith(".css"))
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(COLOR)) {
        const excerpt = (rawLines[index] ?? "").trim().slice(0, 120);
        const found = match[0].endsWith("(") ? `${match[0]}…)` : match[0];
        violations.push(`${file}:${index + 1}:${match.index + 1}: 写了色值 ${found} → ${excerpt}`);
      }
    });
}

if (violations.length > 0) {
  console.error(
    `页面色值检查未通过，共 ${violations.length} 处。颜色取样式变量或主题，状态色取状态字典，页面里不写色值：`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  `页面色值检查通过：扫了 ${scanned} 个文件，没有色值；放行 ${skipped} 个（生成物或白名单）。`,
);
