// Ant Design 全局主题（规范 第 5.4 节的全局主题表）。
// 这里只写“主题变量取哪个样式变量”；取值全部来自 tokens.json，本文件不写色值。

import { GENERATED_BANNER, tokenAt, type Token } from "./tokens.js";

/** raw = 原样；px = 去掉 px 取数字（Ant Design 的尺寸类变量是数字） */
type Convert = "raw" | "px";

/** 主题变量 → tokens.json 的路径。顺序照规范 第 5.4 节的表 */
export const THEME_TOKEN_MAP: ReadonlyArray<readonly [string, string, Convert]> = [
  ["colorPrimary", "shared.color.primary", "raw"],
  ["colorLink", "shared.color.primary-text", "raw"],
  ["colorSuccess", "shared.color.success", "raw"],
  ["colorInfo", "shared.color.info", "raw"],
  ["colorError", "shared.color.danger", "raw"],
  ["colorWarning", "shared.color.warning", "raw"],
  ["colorSuccessBg", "shared.color.success-bg", "raw"],
  ["colorInfoBg", "shared.color.info-bg", "raw"],
  ["colorErrorBg", "shared.color.danger-bg", "raw"],
  ["colorWarningBg", "shared.color.warning-bg", "raw"],
  ["colorSuccessBorder", "admin.color.success-border", "raw"],
  ["colorErrorBorder", "shared.color.danger-border", "raw"],
  ["colorPrimaryBg", "shared.color.primary-bg-subtle", "raw"],
  ["colorPrimaryBgHover", "shared.color.primary-bg", "raw"],
  // 两个都要设：只设 colorTextBase 时正文会被算成带透明度的颜色
  ["colorTextBase", "shared.color.text-primary", "raw"],
  ["colorText", "shared.color.text-primary", "raw"],
  // 说明文字也要可读，第三级不再变浅
  ["colorTextSecondary", "shared.color.text-secondary", "raw"],
  ["colorTextTertiary", "shared.color.text-secondary", "raw"],
  ["colorTextQuaternary", "shared.color.text-disabled", "raw"],
  ["colorTextPlaceholder", "shared.color.text-secondary", "raw"],
  ["colorBorder", "shared.color.border", "raw"],
  ["colorBorderSecondary", "shared.color.border-light", "raw"],
  ["colorSplit", "shared.color.divider", "raw"],
  ["colorBgLayout", "shared.color.bg-page", "raw"],
  ["colorBgContainer", "shared.color.bg-card", "raw"],
  ["colorBgElevated", "shared.color.bg-card", "raw"],
  ["colorFillAlter", "shared.color.bg-subtle", "raw"],
  ["colorFillSecondary", "shared.color.fill-neutral", "raw"],
  ["colorFillTertiary", "shared.color.bg-page", "raw"],
  ["colorBgMask", "shared.color.mask", "raw"],
  ["colorBgSpotlight", "shared.color.bg-inverse", "raw"],
  ["borderRadius", "admin.radius.control", "px"],
  ["borderRadiusLG", "admin.radius.card", "px"],
  ["borderRadiusSM", "admin.radius.icon-button", "px"],
  ["borderRadiusXS", "shared.radius.sm", "px"],
  ["controlHeight", "admin.size.control-md", "px"],
  ["controlHeightLG", "admin.size.control-lg", "px"],
  ["controlHeightSM", "admin.size.control-sm", "px"],
  // 全局字号 14，不设成 13：派生出的小号字会小于 12
  ["fontSize", "admin.font-size.base", "px"],
  ["fontSizeSM", "admin.font-size.caption", "px"],
  // 后台字号里取值 16px 的只有这一个变量
  ["fontSizeLG", "admin.font-size.stat-inline", "px"],
  ["fontFamily", "shared.font.family-sans", "raw"],
  ["fontWeightStrong", "shared.font.weight-semibold", "raw"],
  ["boxShadow", "admin.shadow.toast", "raw"],
  ["boxShadowSecondary", "admin.shadow.toast", "raw"],
];

/** 不来自 tokens.json 的主题开关 */
const THEME_FLAGS: ReadonlyArray<readonly [string, boolean]> = [["wireframe", false]];

/** 衬线字体不进主题，另设一个变量：页面标题、指标数字、品牌字、头像块用 */
const SERIF_PATH = "shared.font.family-serif";

function px(token: Token): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(String(token.value));
  if (!match?.[1]) throw new Error(`${token.section}.${token.group}.${token.name} 不是 px 尺寸`);
  return Number(match[1]);
}

export function buildAntdThemeToken(
  tokens: readonly Token[],
): Record<string, string | number | boolean> {
  const theme: Record<string, string | number | boolean> = {};
  for (const [name, path, convert] of THEME_TOKEN_MAP) {
    const token = tokenAt(tokens, path);
    theme[name] = convert === "px" ? px(token) : token.value;
  }
  for (const [name, flag] of THEME_FLAGS) theme[name] = flag;
  return theme;
}

export function renderAntdThemeTs(tokens: readonly Token[]): string {
  const theme = buildAntdThemeToken(tokens);
  const lines = Object.entries(theme).map(
    ([name, value]) => `    ${name}: ${JSON.stringify(value)},`,
  );
  const serif = tokenAt(tokens, SERIF_PATH).value;
  return [
    `// ${GENERATED_BANNER}。来源：design/tokens.json 与规范 第 5.4 节的全局主题表。重新生成：pnpm design:generate`,
    "// 只有全局主题；组件级覆盖在后台骨架（W0-28）。",
    "",
    "/** Ant Design 全局主题。用法：<ConfigProvider theme={antdTheme}>；类型按安装的 antd 版本标 ThemeConfig */",
    "export const antdTheme = {",
    "  token: {",
    ...lines,
    "  },",
    "} as const;",
    "",
    "/** 衬线字体不进主题：只用于页面标题、指标数字、品牌字、头像块 */",
    `export const fontFamilySerif = ${JSON.stringify(serif)};`,
    "",
  ].join("\n");
}
