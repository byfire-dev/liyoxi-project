import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptPreview } from "./preview";
const props = { url: "https://receipt.example/signed", zoom: 1.5, rotate: 90, onError() {} };
describe("实际凭证预览", () => {
  it("合法PDF临时地址给新窗口入口，图片仍有缩放旋转", () => {
    const pdf = renderToStaticMarkup(
      createElement(ReceiptPreview, { ...props, mime: "application/pdf" }),
    );
    expect(pdf).toContain(`href="${props.url}"`);
    expect(pdf).toContain('target="_blank"');
    expect(pdf).not.toContain("<img");
    expect(pdf).not.toContain("<iframe");
    const image = renderToStaticMarkup(
      createElement(ReceiptPreview, { ...props, mime: "image/jpeg" }),
    );
    expect(image).toContain("<img");
    expect(image).toContain("scale(1.5) rotate(90deg)");
    expect(image).not.toContain("<iframe");
  });
  it("未知MIME明确不能预览，不能作为图片或嵌入HTML", () => {
    const html = renderToStaticMarkup(
      createElement(ReceiptPreview, { ...props, mime: "text/html" }),
    );
    expect(html).toContain("暂不支持预览");
    expect(html).not.toContain(props.url);
  });
});
