// 字体：只用随镜像分发的静态 TTF，按字重分别注册（D6 第 3.5.3 节；D7 第 7.4 节）。
// 目录从环境变量 LYX_PDF_FONT_DIR 取，默认指向仓库的 infra/docker/server/fonts。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Font } from "@react-pdf/renderer";

import { type Coverage, loadCoverage } from "./coverage.ts";
import { hyphenationCallback } from "./linebreak.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** 正文（宋体）与标题（黑体）的字体族名。模板里只写这两个名字 */
export const BODY_FAMILY = "LyxSerifSC";
export const HEADING_FAMILY = "LyxSansSC";

export interface FontFile {
  file: string;
  family: string;
  fontWeight: 400 | 700;
  use: string;
}

export const FONT_FILES: FontFile[] = [
  { file: "NotoSerifSC-Regular.ttf", family: BODY_FAMILY, fontWeight: 400, use: "正文" },
  { file: "NotoSerifSC-Bold.ttf", family: BODY_FAMILY, fontWeight: 700, use: "正文加粗、表头" },
  { file: "NotoSansSC-Bold.ttf", family: HEADING_FAMILY, fontWeight: 700, use: "标题、条款标题" },
];

export function fontDir(): string {
  const fromEnv = process.env.LYX_PDF_FONT_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  return resolve(here, "../../../infra/docker/server/fonts");
}

let registered: { dir: string; coverage: Coverage } | null = null;

/** 注册字体与换行回调。重复调用只做一次；返回三个字体共同收了哪些字 */
export function registerFonts(): Coverage {
  const dir = fontDir();
  if (registered !== null && registered.dir === dir) return registered.coverage;

  const paths = FONT_FILES.map((font) => join(dir, font.file));
  for (const path of paths) statSync(path); // 字体不在就在这里报错，不让渲染悄悄回退

  for (const family of [BODY_FAMILY, HEADING_FAMILY]) {
    Font.register({
      family,
      fonts: FONT_FILES.filter((font) => font.family === family).map((font) => ({
        src: join(dir, font.file),
        fontWeight: font.fontWeight,
      })),
    });
  }
  Font.registerHyphenationCallback(hyphenationCallback);

  const coverage = loadCoverage(paths);
  registered = { dir, coverage };
  return coverage;
}

/** 字体文件的体积与 sha256，给报告用 */
export function describeFonts(): { file: string; use: string; bytes: number; sha256: string }[] {
  const dir = fontDir();
  return FONT_FILES.map((font) => {
    const content = readFileSync(join(dir, font.file));
    return {
      file: font.file,
      use: font.use,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}
