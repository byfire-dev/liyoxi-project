#!/usr/bin/env node
// “页面不写色值”检查（开发计划 第 10.1 节“页面”行；规范 第 6.1 节；CLAUDE.md 硬性规则 24）。
//
// 用法：node infra/ci/check-colors.mjs [--root <目录>] [--allowlist <文件>]   根脚本是 pnpm lint:colors
//   --root       到哪个目录下找 apps/；不给时是当前目录（仓库根）
//   --allowlist  白名单文件；不给时是本脚本旁边的 colors-allowlist.txt
// 口径：
//   1. 扫 apps/weapp/src、apps/admin/src、apps/portal/src 下的 .scss、.css、.ts、.tsx。
//   2. 写了十六进制色值（#RGB、#RGBA、#RRGGBB、#RRGGBBAA）或颜色函数（rgb()、rgba()、hsl()、hsla()、hwb()、
//      lab()、lch()、oklab()、oklch()、color(<色彩空间> …)、color-mix()）即失败，并指出文件、行、列。
//      颜色取样式变量或主题，状态色取状态字典（@liyoxi/shared 的 design 子路径）。
//      由已有颜色算出新颜色也算，不管参数是不是变量：规范里带透明度的颜色都是单列的变量（mask、fill-on-dark），
//      要用就先进 design/tokens.json。两类写法：
//        给变量加透明度的颜色函数，如 rgba($lyx-color-text-primary, 0.45)、color-mix(in srgb, … transparent)；
//        .scss 里 Sass 的颜色运算：transparentize()、fade-out()、fade-in()、opacify()、lighten()、darken()、
//        desaturate()、adjust-hue()、adjust-color()、scale-color()、change-color()、complement()、mix()，
//        以及 color.adjust()、color.scale()、color.change()、color.mix()、color.complement()、
//        color.grayscale()、color.invert()。
//   3. 注释里的不算。样式文件里，选择器位置的 #add 是 id，不算；url(#id) 不算。
//      .ts、.tsx 里，十六进制只认字符串与模板字符串里的（类的私有字段 #abc 不算）；颜色函数在哪都算。
//      Sass 的颜色运算只在 .scss 里认：.css 没有这些函数，.ts 里同名的函数（mix() 之类）多半是别的东西。
//   4. 放行两类：/generated/ 目录下、且第一行带“生成物，勿手改”文件头的生成物；白名单里列的路径。
//      白名单一行一个：文件路径，或以 / 结尾的目录；# 开头是注释。初始为空（规范 第 1.6 节
//      “不进变量的颜色”用到时再加）。加条目属“放松”类门禁改动，走单独的 gate-change PR。
// 退出码：0 通过；1 有违规；2 用法或环境错误。
// 本脚本不引依赖，不解析语法，只认字符串、注释与样式文件的花括号。已知查不到的、会多报的、会认反的：
//   查不到：
//     命名色（color: red、transparent）。
//     与 CSS 滤镜同名的 Sass 颜色函数 grayscale()、invert()、saturate()、opacity()（拦了会误伤 filter 的写法）。
//     第 1 条之外的扩展名：.sass、.less、.mts、.cts、.js、.jsx、.vue、.svg、.wxss、.html 等。
//     src 下软链接过去的目录（不跟进去）。
//     不写成色值样子的色值：数字 0xc4501b、拼出来的字符串（"#" + "c4501b"）。
//     任何 /generated/ 目录下、第一行抄了文件头的手写文件（第 4 条的口径如此；这类新文件复审时要看）。
//   会多报：字符串里写死的“#123”这类编号（编号是变量、写成模板插值时不受影响）。
//   会认反（.ts、.tsx）：正则字面量、JSX 文本里落单的引号、嵌套的模板字符串都不单独识别。一个落单的引号会把
//     它后面的字符串与代码认反，到下一个同样的引号或行尾为止（反引号到下一个反引号为止）：后面的注释可能被
//     当成字符串（多报），后面字符串里的十六进制可能看不到（漏报）。实测漏掉的三种：
//       export const re = /"/; export const c = "#abcdef";
//       <p>say "hi</p>; export const c = "#abcdef";
//       `x ${`#123456`} y`
//     正则里带 // 时，同一行的后半截会被当成注释（那半行不扫）。
//     页面代码里这几种写法少见，遇到时把正则、带引号的文案单独放一行，嵌套的模板字符串拆开写。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_DIRS = ["apps/weapp/src", "apps/admin/src", "apps/portal/src"];
const EXTENSIONS = [".scss", ".css", ".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);
/** 生成物的文件头（packages/shared/scripts/lib/tokens.ts 的 GENERATED_BANNER），须在第一行 */
const GENERATED_BANNER = /^\s*(?:\/\/|\/\*)\s*生成物，勿手改/;
const STYLE_EXTENSIONS = [".scss", ".css"];
/** 十六进制色值。前面是 & 的是 HTML 实体，紧跟在 url( 后面的是 SVG 片段引用，都不算 */
const HEX =
  /(?<![&\w])(?<!url\(\s*["']?)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/gi;
/** 颜色函数。color() 只认第一个参数是色彩空间或 from 的（CSS 的写法），免得拦下同名的自定义函数 */
const COLOR_FUNCTION =
  /(?<![\w$-])(?:(?:(?:rgb|hsl)a?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(|color\(\s*(?:from|srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\s)/gi;
/**
 * Sass 里由已有颜色算出新颜色的函数，只在 .scss 里认。前面带 - 或 . 的是别的函数（lyx-mix()、map.mix()），
 * 模块写法只认 color. 开头的。与 CSS 滤镜同名的 grayscale()、invert()、saturate()、opacity() 不认
 */
const SASS_COLOR_FUNCTION =
  /(?<![\w$.-])(?:(?:transparentize|fade-out|fade-in|opacify|lighten|darken|desaturate|adjust-hue|adjust-color|scale-color|change-color|complement|mix)\s*\(|color\.(?:adjust|scale|change|mix|complement|grayscale|invert)\s*\()/gi;

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

/** 字符串从 start 的引号起，到哪里为止（不含）。普通字符串不跨行：没闭合就到行尾为止 */
function stringEnd(text, start) {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length && text[j] !== quote) {
    // 样式文件里的撇号不至于吞掉后面的内容
    if (text[j] === "\n" && quote !== "`") return j;
    j += text[j] === "\\" ? 2 : 1;
  }
  return Math.min(j + 1, text.length);
}

/**
 * 把文本拆成两份等长的（换行保留，行号、列号不变）：
 * code 是把注释换成空格的原文，字符串原样留着；strings 只留字符串与模板字符串，其余换成空格。
 * lineComments：认不认 // 注释（.css 没有）；style：是不是样式文件（认 url(…)）。
 */
function splitText(text, { lineComments, style }) {
  const code = text.split("");
  const strings = code.map((char) => (char === "\n" ? "\n" : " "));
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (code[i] !== "\n") code[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' || char === "'" || char === "`") {
      const stop = stringEnd(text, i);
      for (let j = i; j < stop; j += 1) strings[j] = text[j];
      i = stop;
    } else if (style && char === "(" && /(?<![\w-])url$/i.test(text.slice(Math.max(0, i - 4), i))) {
      // url(//cdn.example/a.png) 里的 // 不是注释：不带引号的地址整段跳过（带引号的按字符串走）
      let j = i + 1;
      while (text[j] === " ") j += 1;
      if (text[j] !== '"' && text[j] !== "'") {
        while (j < text.length && text[j] !== ")" && text[j] !== "\n") j += 1;
      }
      i = j;
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
  return { code: code.join(""), strings: strings.join("") };
}

/**
 * 样式文件里选择器所在的区间：“{” 之前的那一段，at 规则（@include x(#fff) {）与带值的嵌套属性
 * （border: 1px solid #fff {）除外。区间里的 #add 是 id 选择器，不是色值。入参是去掉注释的文本。
 */
function selectorRanges(code) {
  const ranges = [];
  let start = 0; // 当前这一段从哪开始：上一个 “;”、“{”、“}” 之后
  let interpolation = 0; // #{…} 插值的层数，里面的花括号不算
  let i = 0;
  while (i < code.length) {
    const char = code[i];
    if (char === '"' || char === "'") {
      i = stringEnd(code, i);
    } else if (char === "#" && code[i + 1] === "{") {
      interpolation += 1;
      i += 2;
    } else if (char === "}" && interpolation > 0) {
      interpolation -= 1;
      i += 1;
    } else {
      if (char === "{" && !/^\s*(?:@|[\w-]+\s*:\s)/.test(code.slice(start, i))) {
        ranges.push([start, i]);
      }
      if (char === "{" || char === "}" || char === ";") start = i + 1;
      i += 1;
    }
  }
  return ranges;
}

/** 一个文件里的色值：[{ index, found }]，index 是在全文里的位置 */
function findColors(file, raw) {
  const isStyle = STYLE_EXTENSIONS.some((extension) => file.endsWith(extension));
  const { code, strings } = splitText(raw, {
    lineComments: !file.endsWith(".css"),
    style: isStyle,
  });
  const selectors = isStyle ? selectorRanges(code) : [];
  const inSelector = (index) => selectors.some(([from, to]) => index >= from && index < to);
  const hits = [];
  for (const match of (isStyle ? code : strings).matchAll(HEX)) {
    if (!inSelector(match.index)) hits.push({ index: match.index, found: match[0] });
  }
  const functions = [...code.matchAll(COLOR_FUNCTION)];
  if (file.endsWith(".scss")) functions.push(...code.matchAll(SASS_COLOR_FUNCTION));
  for (const match of functions) {
    hits.push({
      index: match.index,
      found: `${match[0].slice(0, match[0].indexOf("(")).trim()}(…)`,
    });
  }
  return hits.sort((a, b) => a.index - b.index);
}

const { root, allowlist } = parseArgs(process.argv.slice(2));
const allowed = readAllowlist(allowlist);
const isAllowed = (file) =>
  allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

const violations = [];
let scanned = 0;
let skipped = 0;

for (const file of SCAN_DIRS.flatMap((dir) => listFiles(root, dir))) {
  const raw = readFileSync(join(root, file), "utf8");
  const rawLines = raw.split("\n");
  const isGenerated = file.includes("/generated/") && GENERATED_BANNER.test(rawLines[0] ?? "");
  if (isGenerated || isAllowed(file)) {
    skipped += 1;
    continue;
  }
  scanned += 1;
  for (const { index, found } of findColors(file, raw)) {
    const before = raw.slice(0, index).split("\n");
    const line = before.length;
    const column = (before.at(-1) ?? "").length + 1;
    const excerpt = (rawLines[line - 1] ?? "").trim().slice(0, 120);
    violations.push(`${file}:${line}:${column}: 写了色值 ${found} → ${excerpt}`);
  }
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
