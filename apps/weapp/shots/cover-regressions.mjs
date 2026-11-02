import { expect } from "@playwright/test";

/** 真实 React/Taro H5 事件回归；只验证封面恢复行为，不能代替微信真机网络验证。 */
export async function coverRegression(page) {
  const fixture = page.locator("#cover-recovery");
  const image = fixture.locator(".lyx-cover__image");
  const button = (name) => page.locator(".lyx-text-button").filter({ hasText: name });
  const loaded = async () => {
    await expect(image).toHaveCount(1);
    await expect
      .poll(() => image.locator("img").evaluate((node) => node.naturalWidth))
      .toBeGreaterThan(0);
  };
  await fixture.scrollIntoViewIfNeeded();
  await expect(image).toHaveCount(0);
  await expect(fixture.locator(".lyx-cover__title")).toHaveText("封面恢复示例");

  let requests = 0;
  const count = (request) => {
    if (new URL(request.url()).pathname === "/cover-recovery-missing.png") requests++;
  };
  page.on("request", count);
  let held;
  const pattern = "**/cover-recovery-missing.png";
  const hold = (route) => {
    held = route;
  };
  try {
    // 同一地址的父层更新不会复活失败图片或循环请求；显式重挂才重新尝试。
    await button("同地址重渲染").click();
    await expect(fixture).toContainText("父层更新 1");
    await expect(image).toHaveCount(0);
    expect(requests).toBe(0);
    await button("重新挂载重试").click();
    await expect.poll(() => requests).toBe(1);
    await expect(image).toHaveCount(0);
    await button("切换有效封面").click();
    await loaded();

    // 延迟旧地址响应，切回成功地址后再触发旧原生图片的错误事件。
    await page.route(pattern, hold);
    await button("切换失败地址").click();
    await expect.poll(() => Boolean(held)).toBe(true);
    const previousImage = await image.locator("img").elementHandle();
    await button("切换有效封面").click();
    await loaded();
    await held.abort();
    held = undefined;
    await previousImage.evaluate((node) => node.dispatchEvent(new Event("error")));
    await loaded();

    await button("清空封面地址").click();
    await expect(image).toHaveCount(0);
    await button("切换有效封面").click();
    await loaded();
  } finally {
    if (held) await held.abort();
    await page.unroute(pattern, hold);
    page.off("request", count);
  }
}
