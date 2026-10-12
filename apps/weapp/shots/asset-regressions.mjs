import { expect } from "@playwright/test";

/** 同一默认截图轮次里的真实只读 UI 操作，不替代真机或云内容验收。 */
export async function assetRegression(page, scene, origin) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const calls = () => page.evaluate(() => globalThis.__LYX_ASSET_CALLS__ ?? []);
  const detailPath = "/m/store-assets/019aa000-0000-7000-8000-000000000001";
  const readPaths = ["/m/store-assets", "/m/store-assets/summary", detailPath];
  const pathname = (call) => new URL(call.path, origin).pathname;
  if (scene === "asset-lib-loading") {
    await expect(active(".lyx-skeleton")).toBeVisible();
    await expect(active(".asset-lib__item")).toHaveCount(0);
    return;
  }
  const readySelector = scene.startsWith("asset-lib-")
    ? ".asset-lib#asset-ready"
    : ".asset-detail#asset-ready";
  await expect(active(readySelector), `${scene}：初始页面已就绪`).toBeVisible();
  await expect(page.getByText("上传素材", { exact: true })).toHaveCount(0);
  await expect(page.getByText("上传中心", { exact: true })).toHaveCount(0);
  await expect(page.getByText("提交反馈", { exact: true })).toHaveCount(0);
  await expect(page.getByText("补交肖像授权", { exact: true })).toHaveCount(0);
  if (scene === "asset-lib-owner" || scene === "asset-lib-clerk") {
    await expect(active(".asset-lib__item")).toHaveCount(3);
    const input = active('input[placeholder="搜索素材，最多30字"]');
    await input.fill("门店&咖啡");
    await active(".lyx-text-button")
      .filter({ hasText: /^搜索$/ })
      .click();
    await expect.poll(async () => (await calls()).some((c) => c.path.includes("q="))).toBe(true);
    await active(".lyx-chip")
      .filter({ hasText: /^我上传的$/ })
      .click();
    await expect
      .poll(async () => (await calls()).some((c) => c.path.includes("uploader=me")))
      .toBe(true);
    const snapshots = await calls();
    for (const c of snapshots.filter((c) => pathname(c) === "/m/store-assets/summary")) {
      const url = new URL(c.path, origin);
      for (const key of ["tab", "cursor", "limit", "sort"])
        expect(url.searchParams.has(key)).toBe(false);
    }
    await active(".asset-lib__card").first().click();
    await expect(page).toHaveURL(
      /sub\/asset\/detail\/index\?storeAssetId=019aa000-0000-7000-8000-000000000001$/,
    );
    await expect(active(".asset-detail#asset-ready"), `${scene}：素材详情已就绪`).toBeVisible();
    if (scene.endsWith("clerk"))
      await expect(active(".lyx-text-button").filter({ hasText: /查看订单/ })).toHaveCount(0);
    await page.goBack();
    await expect(page, `${scene}：返回原素材库地址`).toHaveURL(
      `${origin}/#/sub/asset/lib/index?lyxShot=${scene}`,
    );
    await expect(active(".asset-lib#asset-ready"), `${scene}：返回素材库已就绪`).toBeVisible();
    // 沿既有“我的”页面菜单进入，未修改首页或菜单实现。
    await page.goto(`${origin}/#/pages/mine/index`, { waitUntil: "networkidle" });
    await expect(active("#account-ready")).toBeVisible();
    await active(".lyx-list-row").filter({ hasText: "素材库" }).click();
    await expect(page).toHaveURL(/sub\/asset\/lib\/index$/);
    await expect(active(".asset-lib#asset-ready"), `${scene}：菜单进入素材库已就绪`).toBeVisible();
  } else if (scene === "asset-lib-more-error") {
    await active(".lyx-text-button")
      .filter({ hasText: /^加载更多$/ })
      .click();
    await expect(active(".lyx-load-error, .lyx-empty")).toContainText("重试");
    await expect(active(".asset-lib__item")).toHaveCount(3);
    const cursorCalls = async () =>
      (await calls()).filter(
        (c) =>
          pathname(c) === "/m/store-assets" && new URL(c.path, origin).searchParams.has("cursor"),
      );
    const failedCalls = await cursorCalls();
    expect(failedCalls).toHaveLength(1);
    const retry = active(".lyx-button").filter({ hasText: "重新加载" });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeVisible();
    await expect(active(".asset-lib__item")).toHaveCount(3);
    expect(await cursorCalls()).toHaveLength(1);
    await retry.click();
    await expect(active(".asset-lib__item")).toHaveCount(5);
    const retriedCalls = await cursorCalls();
    expect(retriedCalls).toHaveLength(2);
    expect(retriedCalls[1].path).toBe(failedCalls[0].path);
    const before = (await calls()).length;
    await expect(active(".lyx-text-button").filter({ hasText: /^加载更多$/ })).toHaveCount(0);
    expect((await calls()).length).toBe(before);
  } else if (scene === "asset-lib-filter-empty") {
    await active(".lyx-chip")
      .filter({ hasText: /^我上传的$/ })
      .click();
    await expect(active(".lyx-empty")).toContainText("没有符合筛选条件");
  } else if (scene === "asset-lib-error") {
    const summaryError = active(".asset-lib > .lyx-page-body > .asset-lib__filters + .lyx-empty");
    const listError = active(".asset-lib > .lyx-page-body > .asset-lib__tags + .lyx-empty");
    await expect(active(".asset-lib > .lyx-page-body > .lyx-empty")).toHaveCount(2);
    for (const region of [summaryError, listError]) {
      await expect(region).toHaveCount(1);
      await expect(region).toContainText("暂时无法加载素材");
      await expect(region.locator(".lyx-button")).toHaveCount(1);
      await expect(region.locator(".lyx-button")).toHaveText("重新加载");
    }
    await expect(active(".asset-lib__item")).toHaveCount(0);
    await expect(page.getByText("private URL must not escape")).toHaveCount(0);
  } else if (scene.endsWith("-error") || scene === "asset-detail-missing") {
    await expect(active(".lyx-empty")).toContainText(
      scene.endsWith("missing") ? "素材不存在或已移除" : "暂时无法加载素材",
    );
    await expect(page.getByText("private URL must not escape")).toHaveCount(0);
  } else if (scene === "asset-detail-partial") {
    await expect(active(".asset-detail")).toContainText("部分内容尚未完成整理");
    await expect(active(".asset-detail")).toContainText("需肖像授权");
  } else if (scene === "asset-detail-organizing") {
    await expect(active(".asset-detail")).toContainText("整理中");
    await expect(active(".asset-detail")).toContainText("暂无整理要点");
  } else if (scene.startsWith("asset-detail-")) {
    await expect(active(".asset-detail")).toContainText("复核与授权");
    await expect(active(".asset-detail")).toContainText("使用记录");
    const before = (await calls()).filter((c) => pathname(c) === detailPath).length;
    await active(".lyx-text-button")
      .filter({ hasText: /^刷新整理结果与文件$/ })
      .click();
    await expect
      .poll(async () => (await calls()).filter((c) => pathname(c) === detailPath).length)
      .toBe(before + 1);
  }
  if (scene === "asset-detail-image") {
    await expect(active(".asset-detail__moderation")).toContainText("已复核 · 审核通过");
    await expect(active(".asset-detail__file > .asset-detail__muted")).toHaveText([
      "可疑待人工",
      "审核通过",
    ]);
  }
  for (const c of await calls()) {
    expect(c.method).toBe("GET");
    expect(readPaths).toContain(pathname(c));
  }
}
