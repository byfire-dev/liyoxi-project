// 渲染一份授权书：snapshot → PDF 字节，外加页数、页脚与缺字的记录。
import { renderToBuffer } from "@react-pdf/renderer";

import { describeChar, replaceUncovered } from "./coverage.ts";
import { registerFonts } from "./fonts.ts";
import { countPageObjects, listBaseFonts } from "./inspect.ts";
import { NBSP } from "./linebreak.ts";
import { extractPages } from "./pdftext.ts";
import { contentFingerprint, type LicenseSnapshot } from "./snapshot.ts";
import { LAYOUT, LicenseLetter } from "./template.ts";

export interface RenderResult {
  pdf: Buffer;
  /** 总页数：取页脚渲染回调拿到的值 */
  pages: number;
  /** PDF 字节里页对象的个数，应与 pages 相等 */
  pageObjects: number;
  /** 页脚回调交出来的每页两行字，下标 0 是第 1 页；回调没被调到的页是 undefined */
  footers: ([string, string] | undefined)[];
  fingerprint: string;
  /** 文件里用到的字体（去掉子集前缀） */
  baseFonts: string[];
  /** 字体没收、被换成替代符号的字，如 “𠮷 U+20BB7” */
  uncovered: string[];
  ms: number;
}

export interface RenderOptions {
  /** 只给用例用：关掉缺字替换，看引擎原本怎么处理字体没收的字 */
  keepUncovered?: boolean;
}

export async function renderLetter(
  snapshot: LicenseSnapshot,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const startedAt = performance.now();
  const coverage = registerFonts();
  const fingerprint = contentFingerprint(snapshot);

  const missing = new Set<string>();
  const clean = options.keepUncovered
    ? (text: string) => text
    : (text: string) => replaceUncovered(text, coverage, missing);

  let totalPages = 0;
  const footerByPage = new Map<number, [string, string]>();
  const pdf = await renderToBuffer(
    LicenseLetter({
      snapshot,
      fingerprint,
      clean,
      onFooter: (info) => {
        totalPages = Math.max(totalPages, info.totalPages);
        footerByPage.set(info.pageNumber, info.lines);
      },
    }),
  );

  return {
    pdf,
    pages: totalPages,
    pageObjects: countPageObjects(pdf),
    footers: Array.from({ length: totalPages }, (_, index) => footerByPage.get(index + 1)),
    fingerprint,
    baseFonts: listBaseFonts(pdf),
    uncovered: [...missing].map(describeChar),
    ms: Math.round(performance.now() - startedAt),
  };
}

/**
 * 每页的页脚是否真的印在了页脚的位置：从文件里把文字读回来，与回调交出来的两行字逐页比对。
 * 不只看回调有没有被调到——回调照常被调用而字被排到页面外面的情况实际遇到过。
 */
export function footersPrinted(result: Pick<RenderResult, "pdf" | "footers">): boolean[] {
  const printed = extractPages(result.pdf);
  return result.footers.map((lines, index) => {
    const page = printed[index];
    if (page === undefined || lines === undefined) return false;
    const footerArea = page.lines
      .filter((line) => line.y > page.height - LAYOUT.paddingBottom)
      .map((line) => line.text.replaceAll(NBSP, " "));
    return lines.every((expected) => footerArea.some((text) => text.includes(expected)));
  });
}
