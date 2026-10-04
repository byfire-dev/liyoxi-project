// 设计地基的生成入口。用法见同目录 README.md。
//   pnpm design:generate                 重新生成 src/design/generated，并出一页预览（不入库）
//   tsx scripts/generate.ts --out <目录>  生成物写到别的目录（门禁自测的反例用）
//   tsx scripts/generate.ts --no-preview  不出预览页
// 生成物目录里有不是脚本写的文件时不生成，退出码 1。

import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STATUS_TONE_GROUPS } from "../src/design/status-tone/index.js";
import { renderAntdThemeTs } from "./lib/antd-theme.js";
import { readIconSources, renderIconsMaskScss, renderIconsTs } from "./lib/icons.js";
import { renderPreview } from "./lib/preview.js";
import { readTokens, renderScss, renderTokensTs } from "./lib/tokens.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageDir, "../..");

export const paths = {
  tokens: join(repoRoot, "design/tokens.json"),
  icons: join(packageDir, "src/design/icons"),
  generated: join(packageDir, "src/design/generated"),
  preview: join(packageDir, "dist/design-preview/index.html"),
};

/** 全部生成物：文件名 → 内容。同一输入两次生成字节相同（不带时间戳，顺序固定） */
export function buildGenerated(
  tokensFile = paths.tokens,
  iconsDir = paths.icons,
): Map<string, string> {
  const tokens = readTokens(tokensFile);
  const icons = readIconSources(iconsDir);
  return new Map([
    ["merchant.scss", renderScss(tokens, "merchant")],
    ["admin.scss", renderScss(tokens, "admin")],
    ["tokens.ts", renderTokensTs(tokens)],
    ["antd-theme.ts", renderAntdThemeTs(tokens)],
    ["icons.ts", renderIconsTs(icons)],
    ["icons-mask.scss", renderIconsMaskScss(icons)],
  ]);
}

export function buildPreview(tokensFile = paths.tokens, iconsDir = paths.icons): string {
  return renderPreview({
    tokens: readTokens(tokensFile),
    icons: readIconSources(iconsDir),
    groups: STATUS_TONE_GROUPS,
  });
}

function writeFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** 生成物目录里不是脚本写的文件（目录只由脚本写；git diff 看不出多出来的文件，由这里拦） */
export function extraFiles(dir: string, generated: ReadonlyMap<string, string>): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !generated.has(name))
    .sort();
}

/** 本文件是不是被直接运行的（被用例 import 时不是）。比真实路径：脚本路径经过软链接时两边写法不同 */
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script || !existsSync(script)) return false;
  return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
}

function main(argv: readonly string[]): void {
  let out = paths.generated;
  let preview = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-preview") preview = false;
    else if (arg === "--out" && argv[i + 1]) out = resolve(argv[(i += 1)] ?? "");
    else {
      console.error(
        `design:generate：不认识的参数 ${arg}。用法见 packages/shared/scripts/README.md`,
      );
      process.exit(2);
    }
  }
  const files = buildGenerated();
  const extra = extraFiles(out, files);
  if (extra.length > 0) {
    console.error(
      `design:generate：${out} 里有不是脚本写的文件：${extra.join("、")}。生成物目录只由脚本写，把它们挪走或删掉再跑`,
    );
    process.exit(1);
  }
  for (const [name, content] of files) writeFile(join(out, name), content);
  console.log(`design:generate：写了 ${files.size} 个生成物 → ${out}`);
  if (preview) {
    writeFile(paths.preview, buildPreview());
    console.log(`design:generate：预览页 → ${paths.preview}`);
  }
}

// 被用例 import 时不执行
if (isEntry()) main(process.argv.slice(2));
