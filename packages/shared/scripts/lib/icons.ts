// 读图标源（src/design/icons/*.svg，文件名即图标名），出图标数据与小程序用的 mask 变量。
// 图标源的写法是固定的：画布 24 × 24、不填充、圆头圆角、颜色跟随文字色（规范 第 9.1 节）。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { GENERATED_BANNER } from "./tokens.js";

export const ICON_VIEW_BOX = "0 0 24 24";
/** 线宽照原型：多数 1.8；返回、关闭、小箭头与后台 16px 及以下为 2；小尺寸对勾 2.4 */
export const ICON_STROKE_WIDTHS = [1.8, 2, 2.4] as const;

export interface IconSource {
  name: string;
  strokeWidth: number;
  /** <svg> 里面的图形标记 */
  body: string;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SOURCE = new RegExp(
  `^<svg xmlns="http://www\\.w3\\.org/2000/svg" viewBox="${ICON_VIEW_BOX}" fill="none" ` +
    `stroke="currentColor" stroke-width="([0-9.]+)" stroke-linecap="round" stroke-linejoin="round">` +
    `(.+)</svg>\\n$`,
);
/** 图形里只许这几种元素与几何属性：出现 fill、stroke、style 即不合规 */
const BODY = /^(?:<(?:path|circle|rect) (?:(?:d|cx|cy|r|x|y|width|height|rx)="[^"<>]*" ?)+\/>)+$/;

export function parseIconSource(name: string, text: string): IconSource {
  if (!NAME.test(name)) throw new Error(`图标名须是小写短横线：${name}`);
  const match = SOURCE.exec(text);
  if (!match?.[1] || !match[2])
    throw new Error(`图标 ${name} 的写法不合规：外层 <svg> 须照固定写法`);
  const strokeWidth = Number(match[1]);
  if (!(ICON_STROKE_WIDTHS as readonly number[]).includes(strokeWidth)) {
    throw new Error(`图标 ${name} 的线宽须是 ${ICON_STROKE_WIDTHS.join("、")} 之一`);
  }
  if (!BODY.test(match[2])) throw new Error(`图标 ${name} 的图形里有不认识的元素或属性`);
  return { name, strokeWidth, body: match[2] };
}

/** 按名字排序读全部图标源；图形相同的不重复收录 */
export function readIconSources(dir: string): IconSource[] {
  const icons = readdirSync(dir)
    .filter((file) => file.endsWith(".svg"))
    .map((file) => file.slice(0, -4))
    .sort()
    .map((name) => parseIconSource(name, readFileSync(join(dir, `${name}.svg`), "utf8")));
  const byBody = new Map<string, string>();
  for (const icon of icons) {
    const same = byBody.get(icon.body);
    if (same) throw new Error(`图标 ${icon.name} 与 ${same} 的图形相同，只收一份`);
    byBody.set(icon.body, icon.name);
  }
  return icons;
}

export function renderIconsTs(icons: readonly IconSource[]): string {
  const widths = ICON_STROKE_WIDTHS.join(" | ");
  return [
    `// ${GENERATED_BANNER}。来源：packages/shared/src/design/icons/*.svg。重新生成：pnpm design:generate`,
    "// 两端共用一套图标。用法：外层 <svg viewBox fill=none stroke=currentColor stroke-linecap=round stroke-linejoin=round>，",
    "// 线宽取各图标自己的 strokeWidth，里面放 body。组件在 W0-27a（小程序）与 W0-28（后台）。",
    "",
    `export const ICON_VIEW_BOX = ${JSON.stringify(ICON_VIEW_BOX)};`,
    "",
    "export const ICON_NAMES = [",
    ...icons.map((icon) => `  ${JSON.stringify(icon.name)},`),
    "] as const;",
    "",
    "/** 图标名是联合类型（写法借自参考工程的 Icon 组件） */",
    "export type IconName = (typeof ICON_NAMES)[number];",
    "",
    `export type IconStrokeWidth = ${widths};`,
    "",
    "export interface IconDef {",
    "  readonly strokeWidth: IconStrokeWidth;",
    "  /** <svg> 里面的图形标记 */",
    "  readonly body: string;",
    "}",
    "",
    "export const ICONS: Readonly<Record<IconName, IconDef>> = {",
    ...icons.map(
      (icon) =>
        `  ${JSON.stringify(icon.name)}: { strokeWidth: ${icon.strokeWidth}, body: ${JSON.stringify(icon.body)} },`,
    ),
    "};",
    "",
  ].join("\n");
}

/** 小程序不能写内联 SVG：把整个图标转成 data URI，配 mask 着色。描边色只是占位，mask 只看透明度 */
export function iconDataUri(icon: IconSource): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${ICON_VIEW_BOX}' fill='none' stroke='black' ` +
    `stroke-width='${icon.strokeWidth}' stroke-linecap='round' stroke-linejoin='round'>` +
    `${icon.body.replaceAll('"', "'")}</svg>`;
  const escaped = svg.replaceAll("%", "%25").replaceAll("#", "%23").replaceAll("<", "%3C");
  return `data:image/svg+xml,${escaped.replaceAll(">", "%3E")}`;
}

export function renderIconsMaskScss(icons: readonly IconSource[]): string {
  return [
    `// ${GENERATED_BANNER}。来源：packages/shared/src/design/icons/*.svg。重新生成：pnpm design:generate`,
    "// 小程序图标用 CSS mask，不用图标字体（D7 第 4.2 节）：取形用 mask-image，取色用 background-color: currentColor。",
    "// 只声明变量，不产出 CSS；类名与 mixin 由小程序的 Icon 组件写（W0-27a）。做法借自参考工程的 Icon 样式。",
    "",
    "$lyx-icon-masks: (",
    ...icons.map((icon) => `  "${icon.name}": "${iconDataUri(icon)}",`),
    ");",
    "",
  ].join("\n");
}
