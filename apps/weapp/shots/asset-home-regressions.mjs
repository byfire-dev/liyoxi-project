import { expect } from "@playwright/test";

export async function homeAssetsRegression(page, scene) {
  const active = (selector) =>
    page.locator(`.taro_page_stationed:not(.taro_page_shade) ${selector}`);
  const root = () => active(".home-assets");
  const calls = () => page.evaluate(() => globalThis.__LYX_ASSET_HOME_CALLS__ ?? []);
  await expect(root().getByText("素材需求", { exact: true })).toBeVisible();
  expect((await calls()).some((path) => path === "/m/asset-demands?status=open&limit=20")).toBe(
    true,
  );
  expect((await calls()).some((path) => path === "/m/store-assets/summary?uploader=me")).toBe(true);
  if (scene === "asset-home-empty-error") {
    await expect(root().getByText("暂无开放的素材需求", { exact: true })).toBeVisible();
    await expect(root().getByText("门店权限已变化，请重新选择门店", { exact: true })).toBeVisible();
    await expect(root().locator(".home-assets__summary")).toHaveCount(0);
    await root()
      .locator(".lyx-button")
      .filter({ hasText: /^重新加载$/ })
      .click();
    await expect(root().locator(".home-assets__summary")).toHaveText("0 条素材 · 0 条被采用");
    return;
  }
  await expect(root().locator(".home-assets__summary")).toHaveText("26 条素材 · 8 条被采用");
  await expect(root().getByText("我已上传 2 条", { exact: true })).toBeVisible();
  await expect(root().getByText("交付经理 · 10 月 20 日前完成", { exact: true })).toBeVisible();
  if (scene === "asset-home-clerk") {
    await expect(active(".home-page").getByText("上线概览", { exact: true })).toHaveCount(0);
    await expect(active(".home-page").getByText("浏览短剧商城", { exact: true })).toBeVisible();
    await root()
      .locator(".lyx-text-button")
      .filter({ hasText: /^为此需求上传$/ })
      .click();
    await expect(page).toHaveURL(
      /sub\/asset\/upload\/index\?assetDemandId=019aa000-0000-7000-8000-000000000009$/,
    );
    await expect(active("#asset-upload-ready")).toBeVisible();
    await expect(active(".asset-upload__demands .lyx-chip--selected")).toHaveText("本周门店日常");
    await active(".asset-upload .lyx-tabs__item")
      .filter({ hasText: /^文字$/ })
      .click();
    await expect(active(".asset-upload__demands .lyx-chip--selected")).toHaveText("本周门店日常");
  } else {
    await expect(active(".home-page").getByText("上线概览", { exact: true })).toBeVisible();
    await root()
      .locator(".lyx-text-button")
      .filter({ hasText: /^查看被采用的素材$/ })
      .click();
    await expect(page).toHaveURL(/sub\/asset\/lib\/index\?uploader=me&status=adopted$/);
    await expect(active(".asset-lib#asset-ready")).toBeVisible();
    await expect(
      active(".asset-lib .lyx-chip--selected").filter({ hasText: /^我上传的$/ }),
    ).toBeVisible();
    await expect(
      active(".asset-lib .lyx-chip--selected").filter({ hasText: /^已采用$/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        (globalThis.__LYX_ASSET_CALLS__ ?? []).some(
          (call) => call.path.includes("uploader=me") && call.path.includes("status=adopted"),
        ),
      ),
    ).toBe(true);
  }
  await page.goBack();
  await expect(active(".home-assets#asset-home-ready")).toBeVisible();
  await expect(root().locator(".home-assets__summary")).toHaveText("26 条素材 · 8 条被采用");
  await root().scrollIntoViewIfNeeded();
}
