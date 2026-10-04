// 把 ADR 依据的几条“引擎行为”固定成用例：@react-pdf/renderer 4.9.0（textkit 7.0.1、layout 5.2.0）。
// 升级渲染库后这些用例若失败，说明行为变了，要回头看 ADR 的做法是否还需要。
import { createElement as h, type ReactElement } from "react";

import { Document, Font, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BODY_FAMILY, registerFonts } from "../src/fonts.ts";
import { listBaseFonts } from "../src/inspect.ts";
import { hyphenationCallback } from "../src/linebreak.ts";
import { extractPages, type PageText } from "../src/pdftext.ts";

beforeAll(() => {
  registerFonts();
});

afterEach(() => {
  // 有的用例换了全局的换行回调，这里换回来
  Font.registerHyphenationCallback(hyphenationCallback);
});

// 小页面：300 × 440 pt，四边各留 20 pt。行高与字号写在同一个样式里（见最后一组用例）
const pageStyle = { padding: 20, fontFamily: BODY_FAMILY, fontSize: 10, lineHeight: 2 } as const;

async function render(...children: ReactElement[]): Promise<{ pdf: Buffer; pages: PageText[] }> {
  const pdf = await renderToBuffer(
    h(Document, null, h(Page, { size: [300, 440], style: pageStyle }, ...children)),
  );
  return { pdf, pages: extractPages(pdf) };
}

const paragraph = "授权方授予被授权方在授权期限与授权地域内发布定制成片的使用许可。".repeat(4);

describe("中文换行", () => {
  it("不注册回调：整段中文被当成一个词，不换行", async () => {
    Font.registerHyphenationCallback((word) => [word]);
    const { pages } = await render(h(Text, null, paragraph));
    expect(pages[0]?.lines).toHaveLength(1);
  });

  it("D6 第 3.5.3 节写的 word => Array.from(word)：能换行，但每个折行处的行尾多出一个连字符", async () => {
    Font.registerHyphenationCallback((word) => Array.from(word));
    const { pages } = await render(h(Text, null, paragraph));
    const lines = pages[0]?.lines ?? [];
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines.slice(0, -1)) expect(line.text.endsWith("-"), line.text).toBe(true);
  });

  it("本工程的回调（段间插空串）：能换行，行尾没有连字符，文字原样", async () => {
    const { pages } = await render(h(Text, null, paragraph));
    const lines = pages[0]?.lines ?? [];
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.map((line) => line.text).join("")).toBe(paragraph);
  });
});

describe("回退到未嵌入的 Helvetica", () => {
  it("字体没收的字：不报错，换用 Helvetica 画", async () => {
    const { pdf } = await render(h(Text, null, "吉野家的𠮷"));
    expect(listBaseFonts(pdf)).toContain("Helvetica");
  });

  it("Text 里的换行符：同样引入 Helvetica", async () => {
    const { pdf } = await render(h(Text, null, "第一行\n第二行"));
    expect(listBaseFonts(pdf)).toContain("Helvetica");
  });

  it("字都收了、不用换行符：只有随附字体", async () => {
    const { pdf } = await render(h(Text, null, "第一行"), h(Text, null, "第二行"));
    expect(listBaseFonts(pdf)).toEqual(["NotoSerifSC-Regular"]);
  });
});

describe("带渲染回调的页脚与行高", () => {
  // 页面高 440pt，页脚贴着底边放：正常应当印在 400pt 以下
  const footer = (child: ReactElement) =>
    h(
      View,
      { fixed: true, style: { position: "absolute", bottom: 10, left: 20, right: 20 } },
      child,
    );
  const body = h(Text, null, paragraph);
  const footerY = (pages: PageText[]) =>
    pages[0]?.lines.find((line) => line.text.includes("页脚第1页"))?.y ?? Number.NaN;

  it("Text 带 render 且有行高：回调照常被调用，字却被排到页面外面", async () => {
    const calls: number[] = [];
    const { pages } = await render(
      body,
      footer(
        h(Text, {
          style: { fontSize: 8, lineHeight: 1.5 },
          render: ({ pageNumber }: { pageNumber: number }) => {
            calls.push(pageNumber);
            return `页脚第${pageNumber}页`;
          },
        }),
      ),
    );
    expect(calls).toContain(1);
    expect(footerY(pages)).toBeLessThan(0);
  });

  it("View 带 render、返回的 Text 靠继承取行高：同样被排到页面外面", async () => {
    const { pages } = await render(
      body,
      footer(
        h(View, {
          render: ({ pageNumber }: { pageNumber: number }) =>
            h(Text, { style: { fontSize: 8 } }, `页脚第${pageNumber}页`),
        }),
      ),
    );
    expect(footerY(pages)).toBeLessThan(0);
  });

  it("View 带 render、行高写在返回的 Text 自己身上：印在页脚的位置", async () => {
    const { pages } = await render(
      body,
      footer(
        h(View, {
          render: ({ pageNumber }: { pageNumber: number }) =>
            h(Text, { style: { fontSize: 8, lineHeight: 1.5 } }, `页脚第${pageNumber}页`),
        }),
      ),
    );
    expect(footerY(pages)).toBeGreaterThan(400);
    expect(footerY(pages)).toBeLessThan(440);
  });
});

describe("标题不留在页尾", () => {
  // 版心高 400pt，行高 20pt，一页 20 行。前面放 18 行，标题是第 19 行；后面的段落至少要两行才肯留在本页
  const filler = Array.from({ length: 18 }, (_, index) =>
    h(Text, { key: index }, `填充行${index + 1}`),
  );
  const following = h(Text, null, paragraph);
  const pageOfTitle = (pages: PageText[]) =>
    pages.findIndex((page) => page.lines.some((line) => line.text.includes("【标题】")));

  it("不设 minPresenceAhead：标题孤零零留在第 1 页页尾", async () => {
    const { pages } = await render(...filler, h(Text, null, "【标题】"), following);
    expect(pageOfTitle(pages)).toBe(0);
    expect(pages[0]?.lines.at(-1)?.text).toBe("【标题】");
  });

  it("设了 minPresenceAhead：标题跟着正文挪到第 2 页", async () => {
    const { pages } = await render(
      ...filler,
      h(Text, { minPresenceAhead: 40 }, "【标题】"),
      following,
    );
    expect(pageOfTitle(pages)).toBe(1);
  });
});

describe("行高按谁的字号算", () => {
  const baselines = (pages: PageText[]) => (pages[0]?.lines ?? []).map((line) => line.y);

  it("行高与字号写在同一个样式里：行距 = 行高 × 该字号", async () => {
    const style = { fontSize: 10, lineHeight: 3 };
    const { pages } = await render(h(Text, { style }, "第一行"), h(Text, { style }, "第二行"));
    const [first = 0, second = 0] = baselines(pages);
    expect(second - first).toBeCloseTo(30, 0);
  });

  it("只写行高、字号靠继承：行距按默认的 18pt 算，不按继承来的字号", async () => {
    const style = { lineHeight: 3 };
    const { pages } = await render(h(Text, { style }, "第一行"), h(Text, { style }, "第二行"));
    const [first = 0, second = 0] = baselines(pages);
    expect(second - first).toBeCloseTo(54, 0);
  });
});
