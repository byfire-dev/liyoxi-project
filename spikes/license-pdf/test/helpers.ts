import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PageText, TextLine } from "../src/pdftext.ts";
import type { LicenseSnapshot } from "../src/snapshot.ts";
import { LAYOUT } from "../src/template.ts";

const here = dirname(fileURLToPath(import.meta.url));

export type SampleName = "short" | "long" | "extreme";

export function loadSample(name: SampleName): LicenseSnapshot {
  return JSON.parse(
    readFileSync(join(here, "../samples", `${name}.json`), "utf8"),
  ) as LicenseSnapshot;
}

/** 版心里的行：去掉页眉与页脚 */
export function bodyLines(page: PageText): TextLine[] {
  return page.lines.filter(
    (line) => line.y > LAYOUT.paddingTop - 4 && line.y < page.height - LAYOUT.paddingBottom + 4,
  );
}

/** 页脚区域的行 */
export function footerLinesOf(page: PageText): TextLine[] {
  return page.lines.filter((line) => line.y >= page.height - LAYOUT.paddingBottom + 4);
}

/** 页眉区域的行 */
export function headerLinesOf(page: PageText): TextLine[] {
  return page.lines.filter((line) => line.y <= LAYOUT.paddingTop - 4);
}

/** 去掉全部空白，用来比对文字是否连续。正则里的 \s 已包含不换行空格与全角空格 */
export function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 全文版心文字，按页、按行接起来 */
export function bodyText(pages: PageText[]): string {
  return squash(
    pages
      .flatMap((page) => bodyLines(page))
      .map((line) => line.text)
      .join(""),
  );
}

export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}
