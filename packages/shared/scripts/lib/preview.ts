// 静态预览页：两端色板、字号、全部图标（带名字）、状态标签两端各一列。
// 不入库，作为 CI 产物上传，供业主对照规范 第 1、6、9 节与原型截图看样。
// 页面上的颜色全部取自 tokens.json，本文件不写色值。

import type { StatusToneGroup, ToneSide } from "../../src/design/status-tone/index.js";
import { ICON_VIEW_BOX, type IconSource } from "./icons.js";
import { SECTIONS, type Section, type Side, type Token, tokenAt } from "./tokens.js";

export interface PreviewInput {
  tokens: readonly Token[];
  icons: readonly IconSource[];
  groups: readonly StatusToneGroup[];
}

const SECTION_TITLE: Record<Section, string> = {
  shared: "两端共用",
  merchant: "仅商家端",
  admin: "仅后台",
};
const SIDE_TITLE: Record<Side, string> = { merchant: "商家端", admin: "后台" };

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function swatches(tokens: readonly Token[], section: Section): string {
  const cells = tokens
    .filter((t) => t.section === section && t.type === "color")
    .map(
      (t) =>
        `<li><span class="chip" style="background:${escapeHtml(String(t.value))}"></span>` +
        `<b>${escapeHtml(t.name)}</b><code>${escapeHtml(String(t.value))}</code></li>`,
    );
  return `<h3>${SECTION_TITLE[section]}（${cells.length}）</h3><ul class="swatches">${cells.join("")}</ul>`;
}

function fontSizes(tokens: readonly Token[], side: Side): string {
  const rows = tokens
    .filter((t) => t.section === side && t.group === "font-size")
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.name)} · ${escapeHtml(String(t.value))}</code>` +
        `<span style="font-size:${escapeHtml(String(t.value))}">狸有戏 短剧营销 ¥3,000 · 2,160 积分</span></li>`,
    );
  return `<h3>${SIDE_TITLE[side]}</h3><ul class="sizes">${rows.join("")}</ul>`;
}

function iconGrid(icons: readonly IconSource[]): string {
  const cells = icons.map(
    (icon) =>
      `<li><svg width="24" height="24" viewBox="${ICON_VIEW_BOX}" fill="none" stroke="currentColor" ` +
      `stroke-width="${icon.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${icon.body}</svg>` +
      `<b>${escapeHtml(icon.name)}</b><code>线宽 ${icon.strokeWidth}</code></li>`,
  );
  return `<ul class="icons">${cells.join("")}</ul>`;
}

function tag(side: Side, value: ToneSide | null): string {
  if (!value) return "<td>—</td>";
  return `<td><span class="tag tag--${side} tag--${value.tone}">${escapeHtml(value.label)}</span></td>`;
}

function statusTable(groups: readonly StatusToneGroup[]): string {
  const rows = groups.flatMap((group) =>
    group.entries.map((e, index) => {
      const key = e.column ? `${e.column} = ${e.values.join("、")}` : "无枚举对应";
      const head =
        index === 0 ? `<th rowspan="${group.entries.length}">${escapeHtml(group.object)}</th>` : "";
      return (
        `<tr>${head}<td>${escapeHtml(e.state)}</td>${tag("merchant", e.merchant)}` +
        `${tag("admin", e.admin)}<td><code>${escapeHtml(key)}</code></td></tr>`
      );
    }),
  );
  return (
    `<table><thead><tr><th>业务对象</th><th>状态</th><th>商家端</th><th>后台</th>` +
    `<th>库里的键</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
  );
}

function styles(tokens: readonly Token[]): string {
  const v = (path: string): string => String(tokenAt(tokens, path).value);
  const tones = ["success", "info", "warning", "danger", "neutral"].map(
    (tone) =>
      `.tag--${tone}{color:${v(`shared.color.${tone}`)};background:${v(`shared.color.${tone}-bg`)}}`,
  );
  tones.push(
    `.tag--purple{color:${v("admin.color.purple")};background:${v("admin.color.purple-bg")}}`,
  );
  return [
    `body{margin:0;padding:24px;font-family:${v("shared.font.family-sans")};font-size:14px;` +
      `color:${v("shared.color.text-primary")};background:${v("shared.color.bg-page")}}`,
    `h1{font-family:${v("shared.font.family-serif")};font-size:24px}`,
    `section{background:${v("shared.color.bg-card")};border:1px solid ${v("shared.color.border-light")};` +
      `border-radius:12px;padding:16px 20px;margin:16px 0}`,
    `code{font-family:${v("shared.font.family-mono")};font-size:12px;color:${v("shared.color.text-secondary")}}`,
    "ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:12px}",
    "li{display:flex;flex-direction:column;gap:4px}",
    ".swatches li{width:148px}",
    `.chip{height:40px;border-radius:8px;border:1px solid ${v("shared.color.border")}}`,
    ".sizes{flex-direction:column}",
    ".icons li{width:112px;align-items:center;text-align:center;font-size:12px}",
    "table{border-collapse:collapse;width:100%}",
    `th,td{text-align:left;padding:6px 10px;border-bottom:1px solid ${v("shared.color.divider")};vertical-align:top}`,
    ".tag{display:inline-block;font-size:12px;font-weight:600;white-space:nowrap}",
    `.tag--merchant{padding:1px 6px;border-radius:${v("merchant.radius.tag")}}`,
    `.tag--admin{height:${v("admin.size.tag")};line-height:${v("admin.size.tag")};padding:0 10px;` +
      `border-radius:${v("shared.radius.pill")}}`,
    ...tones,
  ].join("\n");
}

export function renderPreview({ tokens, icons, groups }: PreviewInput): string {
  const entryCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>狸有戏 · 设计地基预览</title>",
    `<style>\n${styles(tokens)}\n</style></head><body>`,
    "<h1>狸有戏 · 设计地基预览</h1>",
    `<p>样式变量 ${tokens.length} 个；图标 ${icons.length} 个；状态条目 ${entryCount} 条（${groups.length} 个业务对象）。` +
      "对照规范 第 1、6、9 节与原型截图看。</p>",
    `<section><h2>色板</h2>${SECTIONS.map((s) => swatches(tokens, s)).join("")}</section>`,
    `<section><h2>字号</h2>${fontSizes(tokens, "merchant")}${fontSizes(tokens, "admin")}</section>`,
    `<section><h2>图标（${icons.length}）</h2>${iconGrid(icons)}</section>`,
    `<section><h2>状态标签</h2>${statusTable(groups)}</section>`,
    "</body></html>",
    "",
  ].join("\n");
}
