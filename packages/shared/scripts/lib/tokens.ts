// 读 design/tokens.json，摊平成一张变量表；再出两端的 scss 变量文件与 TS 常量。
// 取值只来自 tokens.json：本文件不写任何色值、字号、尺寸。

import { readFileSync } from "node:fs";

export const SECTIONS = ["shared", "merchant", "admin"] as const;
export type Section = (typeof SECTIONS)[number];
/** 一端的样式文件 = 两端共用段 + 这一端的专有段 */
export const SIDES = ["merchant", "admin"] as const;
export type Side = (typeof SIDES)[number];

export type TokenValue = string | number;

export interface Token {
  section: Section;
  /** tokens.json 的第二层键：color、font-size、radius…… */
  group: string;
  /** tokens.json 的第三层键，与规范里的变量名一致 */
  name: string;
  type: string;
  value: TokenValue;
  description: string;
}

/** 生成物文件头里的那句话；检查脚本与用例也认它 */
export const GENERATED_BANNER = "生成物，勿手改";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 按 tokens.json 里的先后顺序摊平。以 $ 开头的键是说明，不是变量 */
export function parseTokens(json: string): Token[] {
  const root: unknown = JSON.parse(json);
  if (!isRecord(root)) throw new Error("tokens.json 的顶层须是对象");
  const tokens: Token[] = [];
  for (const section of SECTIONS) {
    const groups = root[section];
    if (!isRecord(groups)) throw new Error(`tokens.json 缺少 ${section} 段`);
    for (const [group, entries] of Object.entries(groups)) {
      if (group.startsWith("$")) continue;
      if (!isRecord(entries)) throw new Error(`${section}.${group} 须是对象`);
      for (const [name, raw] of Object.entries(entries)) {
        if (name.startsWith("$")) continue;
        const path = `${section}.${group}.${name}`;
        if (!isRecord(raw)) throw new Error(`${path} 须是对象`);
        const { $type: type, $value: value, $description: description } = raw;
        if (typeof type !== "string") throw new Error(`${path} 缺少 $type`);
        if (typeof value !== "string" && typeof value !== "number") {
          throw new Error(`${path} 的 $value 须是字符串或数字`);
        }
        tokens.push({
          section,
          group,
          name,
          type,
          value,
          description: typeof description === "string" ? description : "",
        });
      }
    }
  }
  return tokens;
}

export function readTokens(file: string): Token[] {
  return parseTokens(readFileSync(file, "utf8"));
}

/** 按“段.组.名”取一个变量；没有即抛错，生成不出半截的主题 */
export function tokenAt(tokens: readonly Token[], path: string): Token {
  const found = tokens.find((t) => `${t.section}.${t.group}.${t.name}` === path);
  if (!found) throw new Error(`tokens.json 里没有 ${path}`);
  return found;
}

/** scss 变量名：前缀 lyx（D7 第 2.5 节），后接组名与变量名 */
export const scssName = (token: Pick<Token, "group" | "name">): string =>
  `$lyx-${token.group}-${token.name}`;

/** 一端的变量 = shared 段 + 这一端的段；同名即抛错 */
export function tokensForSide(tokens: readonly Token[], side: Side): Token[] {
  const picked = tokens.filter((t) => t.section === "shared" || t.section === side);
  const seen = new Set<string>();
  for (const token of picked) {
    const name = scssName(token);
    if (seen.has(name)) throw new Error(`${side} 端的变量名重复：${name}`);
    seen.add(name);
  }
  return picked;
}

const header = (source: string, extra: readonly string[] = []): string =>
  [
    `// ${GENERATED_BANNER}。来源：${source}。重新生成：pnpm design:generate`,
    ...extra.map((line) => `// ${line}`),
    "",
  ].join("\n");

/** 一端的 scss 变量文件：只声明变量，不产出 CSS（形态借自参考工程的 tokens.scss） */
export function renderScss(tokens: readonly Token[], side: Side): string {
  const lines: string[] = [];
  let current = "";
  for (const token of tokensForSide(tokens, side)) {
    const heading = `${token.section}.${token.group}`;
    if (heading !== current) {
      lines.push("", `// ---- ${heading}`);
      current = heading;
    }
    const comment = token.description ? ` // ${token.description}` : "";
    lines.push(`${scssName(token)}: ${token.value};${comment}`);
  }
  const usage =
    side === "merchant"
      ? "只声明变量，不产出 CSS。小程序 designWidth 设 375，px 数值原样写进样式文件，不乘换算系数（规范 第 4.1 节）。"
      : "只声明变量，不产出 CSS。后台全局主题另见 antd-theme.ts。";
  return `${header(`design/tokens.json（shared、${side} 两段）`, [usage])}\n${lines.join("\n").trimStart()}\n`;
}

/** TS 常量：三段各一个对象，键名与 tokens.json 一致，值原样 */
export function renderTokensTs(tokens: readonly Token[]): string {
  const blocks = SECTIONS.map((section) => {
    const groups: string[] = [];
    let current = "";
    for (const token of tokens.filter((t) => t.section === section)) {
      if (token.group !== current) {
        if (current) groups.push("  },");
        groups.push(`  ${JSON.stringify(token.group)}: {`);
        current = token.group;
      }
      groups.push(`    ${JSON.stringify(token.name)}: ${JSON.stringify(token.value)},`);
    }
    if (current) groups.push("  },");
    return `export const ${section}Tokens = {\n${groups.join("\n")}\n} as const;`;
  });
  return `${header("design/tokens.json", [
    "键名与 tokens.json、规范 第 1–3 节的变量名一致；值原样（尺寸带 px）。",
  ])}\n${blocks.join("\n\n")}\n`;
}
