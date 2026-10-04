// 三份样张：页数、页脚、换行、分页、溢出、体积、字体。
// 页数取页脚渲染回调拿到的值，再与 PDF 里的页对象数、读回来的页数互相印证。
// 页脚是否真的印在每一页上，从 PDF 里把文字读回来核对（回调被调用不等于文字画上去了）。
import { beforeAll, describe, expect, it } from "vitest";

import { clauseFor } from "../src/clauses.ts";
import { MISSING_MARK, replaceUncovered } from "../src/coverage.ts";
import { FONT_FILES, registerFonts } from "../src/fonts.ts";
import { MAX_BYTES } from "../src/limits.ts";
import { NBSP } from "../src/linebreak.ts";
import { extractPages, type PageText } from "../src/pdftext.ts";
import { footersPrinted, renderLetter, type RenderResult } from "../src/render.ts";
import type { LicenseSnapshot } from "../src/snapshot.ts";
import { LAYOUT, PLACEHOLDER_MARK } from "../src/template.ts";
import {
  bodyLines,
  bodyText,
  countOccurrences,
  footerLinesOf,
  headerLinesOf,
  loadSample,
  type SampleName,
  squash,
} from "./helpers.ts";

/** 三份样张的总页数区间（任务书 第 7 节第 2 条：区间写在用例里） */
const PAGE_RANGE: Record<SampleName, [min: number, max: number]> = {
  short: [1, 1],
  long: [3, 5],
  extreme: [5, 7],
};

const NO_LINE_START = "，。、；：？！）》」』】〕〉〗”’…—～·％‰";
const NO_LINE_END = "（《「『【〔〈〖“‘";
const BUNDLED = FONT_FILES.map((font) => font.file.replace(/\.ttf$/, ""));

describe.each(["short", "long", "extreme"] as const)("样张 %s", (name) => {
  let snapshot: LicenseSnapshot;
  let first: RenderResult;
  let second: RenderResult;
  let pages: PageText[];

  beforeAll(async () => {
    snapshot = loadSample(name);
    first = await renderLetter(snapshot);
    second = await renderLetter(snapshot);
    pages = extractPages(first.pdf);
  });

  it("总页数落在写明的区间里", () => {
    const [min, max] = PAGE_RANGE[name];
    expect(first.pages).toBeGreaterThanOrEqual(min);
    expect(first.pages).toBeLessThanOrEqual(max);
  });

  it("同一份 snapshot 渲染两次页数相同；字节不比对", () => {
    expect(second.pages).toBe(first.pages);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("页脚回调拿到的页数 = 文件里的页对象数 = 读回来的页数", () => {
    expect(first.pageObjects).toBe(first.pages);
    expect(pages).toHaveLength(first.pages);
  });

  it("每页都印了页脚：编号、版次、内容指纹、页码，页码连续", () => {
    expect(footersPrinted(first)).toEqual(Array.from({ length: first.pages }, () => true));
    pages.forEach((page, index) => {
      const footer = footerLinesOf(page)
        .map((line) => line.text.replaceAll(NBSP, " "))
        .join("\n");
      expect(footer, `第 ${index + 1} 页`).toContain(`编号 ${snapshot.letterNo}`);
      expect(footer, `第 ${index + 1} 页`).toContain(`第 ${snapshot.revNo} 版`);
      expect(footer, `第 ${index + 1} 页`).toContain(`第 ${index + 1} 页 / 共 ${first.pages} 页`);
      expect(footer, `第 ${index + 1} 页`).toContain(`内容指纹 ${first.fingerprint}`);
      // 回调交出来的两行字都真的印在了这一页上
      for (const line of first.footers[index] ?? ["回调没有被调到", ""]) {
        expect(footer, `第 ${index + 1} 页`).toContain(line);
      }
    });
  });

  it("每页页眉都标了“占位，非法务定稿”", () => {
    for (const page of pages) {
      expect(
        headerLinesOf(page)
          .map((line) => line.text)
          .join(""),
      ).toContain(PLACEHOLDER_MARK);
    }
  });

  it("句号、逗号、顿号、右引号、右括号不出现在行首；左引号、左括号不出现在行尾", () => {
    for (const page of pages) {
      for (const line of bodyLines(page)) {
        const text = line.text.replace(/\s+$/, "");
        const head = Array.from(text)[0] ?? "";
        const tail = Array.from(text).at(-1) ?? "";
        expect(NO_LINE_START.includes(head), `行首：${text}`).toBe(false);
        expect(NO_LINE_END.includes(tail), `行尾：${text}`).toBe(false);
      }
    }
  });

  it("没有一行超出版心左右两边（长编号、信用代码、网址、超长串不溢出页边）", () => {
    for (const page of pages) {
      for (const line of page.lines) {
        expect(line.x, line.text).toBeGreaterThanOrEqual(LAYOUT.side - 0.5);
        expect(line.right, line.text).toBeLessThanOrEqual(page.width - LAYOUT.side + 0.5);
      }
    }
  });

  it("条款每一段的文字连续、只出现一次：分页处不丢行、不重行，行尾没有多出连字符", () => {
    const coverage = registerFonts();
    const text = bodyText(pages);
    const keys = [
      snapshot.rightsClauseKey,
      snapshot.exclusiveClauseKey,
      snapshot.obligationClauseKey,
    ];
    for (const key of keys) {
      const clause = clauseFor(key);
      expect(countOccurrences(text, squash(clause.title)), clause.title).toBe(1);
      for (const item of clause.items) {
        const expected = squash(replaceUncovered(item.replaceAll("**", ""), coverage, new Set()));
        expect(countOccurrences(text, expected), item.slice(0, 24)).toBe(1);
      }
    }
  });

  it("条款标题不单独留在页尾", () => {
    const keys = [
      snapshot.rightsClauseKey,
      snapshot.exclusiveClauseKey,
      snapshot.obligationClauseKey,
    ];
    const titles = keys.map((key) => squash(clauseFor(key).title));
    for (const page of pages) {
      const last = squash(bodyLines(page).at(-1)?.text ?? "");
      expect(titles, `页尾：${last}`).not.toContain(last);
    }
  });

  it("单份不超过 1MB", () => {
    expect(first.pdf.length).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("文件里只有随附的字体，没有回退到未嵌入的内置字体", () => {
    expect(first.baseFonts.length).toBeGreaterThan(0);
    for (const font of first.baseFonts) expect(BUNDLED, font).toContain(font);
  });
});

describe("极端样张里的生僻字", () => {
  it("字体没收的字被换成替代符号，并列进报告", async () => {
    const result = await renderLetter(loadSample("extreme"));
    expect(result.uncovered).toEqual(expect.arrayContaining(["𠮷 U+20BB7", "😀 U+1F600"]));
    const text = bodyText(extractPages(result.pdf));
    expect(text).toContain(`${MISSING_MARK}野家官方号${MISSING_MARK}`);
    expect(text).not.toContain("𠮷");
  });

  it("字体收了的生僻字原样印出：䶮、龘、㙟、𬌗", async () => {
    const result = await renderLetter(loadSample("extreme"));
    const text = bodyText(extractPages(result.pdf));
    for (const char of "䶮龘㙟𬌗𫖯鱻麤") expect(text, char).toContain(char);
  });

  it("要素表跨页：第 1 页与第 2 页都有要素表的行", async () => {
    const result = await renderLetter(loadSample("extreme"));
    const pages = extractPages(result.pdf);
    const texts = pages.map((page) =>
      squash(
        bodyLines(page)
          .map((line) => line.text)
          .join(""),
      ),
    );
    expect(texts[0]).toContain("许可信息14");
    expect(texts[1]).toContain("发布账号");
  });
});
