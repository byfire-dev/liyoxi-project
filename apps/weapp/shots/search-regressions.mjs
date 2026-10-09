import { expect } from "@playwright/test";

/** 沿原首页/商城场景验证真实页面导航；只替换接口边界，不伪造路由或卡片点击。 */
export async function searchEntryRegression(page, scene) {
  if (!scene.startsWith("home-") && !scene.startsWith("mall-")) return;
  const entry = page.locator(".lyx-button:visible").filter({ hasText: "搜索剧名、题材、主演" });
  await expect(entry).toBeVisible();
  if (scene !== "home-owner" && scene !== "mall-default") return;
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  let filters;
  if (scene === "mall-default") {
    await active(".lyx-filter-chips__item")
      .filter({ hasText: /^都市生活$/ })
      .click();
    await expect(active("#catalog-ready")).toBeVisible();
    await active(".lyx-filter-chips__item")
      .filter({ hasText: /^积分从低到高$/ })
      .click();
    await expect(active("#catalog-ready")).toBeVisible();
    filters = await active(".lyx-filter-chips__item--active").allTextContents();
  }
  await entry.click();
  await expect(page).toHaveURL(/sub\/catalog\/search\/index\?from=(home|mall)/);
  const input = active('input[placeholder="搜索剧名、题材、主演"]');
  await expect(active("#search-ready")).toBeVisible();
  await input.fill("烟火");
  await active(".lyx-button")
    .filter({ hasText: /^搜索$/ })
    .click();
  await expect(active(".search-page__result")).toHaveCount(3);
  await active(".search-page__result").first().click();
  await expect(page).toHaveURL(
    /sub\/catalog\/detail\/index\?dramaId=00000000-0000-4000-8000-000000000001/,
  );
  await expect(active("#catalog-ready")).toBeVisible();
  await page.goBack();
  await expect(active("#search-ready")).toBeVisible();
  await expect(input).toHaveValue("烟火");
  await expect(active(".search-page__result")).toHaveCount(3);
  await page.goBack();
  await expect(active("#catalog-ready")).toBeVisible();
  await expect(entry).toBeVisible();
  if (filters)
    expect(await active(".lyx-filter-chips__item--active").allTextContents()).toEqual(filters);
}

/** 离线 DTO 接线/界面交互证据，不能代替真实 API 或真机。 */
export async function searchRegression(page, scene) {
  const input = page.locator('.search-page input[placeholder="搜索剧名、题材、主演"]');
  await expect(page.locator(".search-page__hot-word")).toHaveCount(8);
  const q =
    scene === "search-fallback"
      ? "火锅"
      : scene === "search-clerk"
        ? "都市生活"
        : scene === "search-guest"
          ? "林晓"
          : "烟火";
  await input.fill(q);
  await page
    .locator(".search-page .lyx-button")
    .filter({ hasText: /^搜索$/ })
    .click();
  if (scene === "search-error") {
    await expect(page.getByText("网络异常，请检查网络后重试", { exact: true })).toBeVisible();
    await expect(page.locator(".search-page__result")).toHaveCount(0);
    await expect(page.getByText(/没有找到/)).toHaveCount(0);
    return;
  }
  if (scene === "search-empty") {
    await expect(page.getByText(`没有找到“${q}”相关的短剧`, { exact: true })).toBeVisible();
    await expect(page.locator(".search-page__result")).toHaveCount(0);
    return;
  }
  await expect(page.locator(".search-page__result")).toHaveCount(scene === "search-more" ? 20 : 3);
  if (scene === "search-idle") {
    await page.locator(".search-page .lyx-icon-button").click();
    await expect(page.locator(".search-page__result")).toHaveCount(0);
    await expect(page.locator(".search-page__chip")).toHaveText([q]);
    await expect(page.locator(".search-page__hot-word")).toHaveCount(8);
    await page.locator(".search-page__clear").click();
    await expect(page.locator(".search-page__chip")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("lyx.searchHistory"))).toBeNull();
    await page.locator(".search-page__hot-word").first().click();
    await expect(page.locator(".search-page__result")).toHaveCount(3);
    await page.locator(".search-page .lyx-icon-button").click();
    await expect(page.locator(".search-page__chip")).toHaveText([q]);
    return;
  }
  if (scene.endsWith("clerk") || scene.endsWith("guest")) {
    await expect(page.getByText(/实扣/)).toHaveCount(0);
    await expect(page.getByText(/专业版/)).toHaveCount(0);
  }
  if (scene === "search-guest")
    await expect(page.getByText("主演匹配", { exact: true })).toHaveCount(3);
  if (scene === "search-fallback") {
    await expect(page.locator(".search-page__fallback")).toContainText("餐饮行业（火锅）");
    await expect(page.locator(".search-page__hit")).toHaveCount(0);
  }
  if (scene === "search-more") {
    const more = page.locator(".search-page .lyx-button").filter({ hasText: "加载更多" });
    await more.scrollIntoViewIfNeeded();
    await expect(page.getByText("暂时无法加载更多，请重试", { exact: true })).toBeVisible();
    await expect(page.locator(".search-page__result")).toHaveCount(20);
    const first = await page.evaluate(() =>
      globalThis.__LYX_SEARCH_CALLS__.filter((call) =>
        new URL(call.path, "http://local").searchParams.has("cursor"),
      ),
    );
    expect(first).toHaveLength(1);
    await page
      .locator(".search-page .lyx-button")
      .filter({ hasText: /^重试加载更多$/ })
      .click();
    await expect(page.locator(".search-page__result")).toHaveCount(24);
    const retried = await page.evaluate(() =>
      globalThis.__LYX_SEARCH_CALLS__.filter((call) =>
        new URL(call.path, "http://local").searchParams.has("cursor"),
      ),
    );
    expect(retried).toHaveLength(2);
    expect(retried[1].path).toBe(first[0].path);
    await expect(page.getByText("没有更多了", { exact: true })).toBeVisible();
    await page.getByText("没有更多了", { exact: true }).scrollIntoViewIfNeeded();
  }
  const calls = await page.evaluate(() => globalThis.__LYX_SEARCH_CALLS__);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(
    calls.every(
      (call) => call.path.startsWith("/m/dramas/search?") || call.path === "/m/mall-config",
    ),
  ).toBe(true);
}
