import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { LandingPage } from "./LandingPage";

it("公开落地页说明设置中的实际授权入口，不臆断扫码平台结论或依赖下载页", () => {
  const html = renderToStaticMarkup(<LandingPage />);
  for (const text of [
    "设置",
    "已授权的电脑",
    "授权电脑",
    "输入授权码",
    "8 位登录码",
    "两位确认数字",
  ])
    expect(html).toContain(text);
  expect(html).toContain("本页仅提供操作说明");
  expect(html).not.toMatch(/扫一扫.*不能|进入成片下载页|电脑下载」|PR28|等待开发|已验证/);
  expect(html).not.toContain("<button");
});
