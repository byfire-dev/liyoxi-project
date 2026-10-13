import { expect } from "@playwright/test";

export async function assetActionRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const button = (text) => active(".lyx-button").filter({ hasText: new RegExp(`^${text}$`) });
  const calls = () => page.evaluate(() => globalThis.__LYX_ASSET_ACTION_CALLS__ ?? []);
  await expect(active(".asset-detail#asset-ready")).toBeVisible();
  if (scene.includes("denied")) {
    await expect(active(".asset-feedback, .asset-portrait")).toHaveCount(0);
    expect((await calls()).every((call) => call.method === "GET")).toBe(true);
    return;
  }
  if (scene.includes("feedback")) {
    await active(".asset-feedback .lyx-text-button").click();
    await active("textarea").fill("用途标签与门店实拍内容不符");
    await active(".asset-feedback .lyx-chip")
      .filter({ hasText: /^用途$/ })
      .click();
    await button("提交反馈").click();
    await expect(active(".asset-feedback-message")).toContainText(
      scene.includes("limit") ? "已满5次" : "反馈已提交",
    );
    const submitted = (await calls()).filter((call) => call.path.endsWith("/feedback"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].data).toEqual({
      content: "用途标签与门店实拍内容不符",
      dimension: "usage",
    });
    expect(submitted[0].key).toBeTruthy();
    return;
  }
  await active(".asset-portrait .lyx-text-button").click();
  await button(scene.includes("success") ? "选择PDF授权材料" : "选择授权图片").click();
  if (scene.includes("partial")) {
    await expect(active(".asset-portrait")).toContainText("上传未完成");
    await expect(button("提交授权材料")).toBeDisabled();
    await button("重试未完成上传").click();
  }
  await expect(active(".asset-portrait .asset-detail__muted")).toHaveText(["已入库", "已入库"]);
  await button("提交授权材料").click();
  if (scene.includes("unknown")) {
    await expect(active(".asset-portrait-message")).toContainText("尚未确认");
    await expect(button("选择授权图片")).toBeDisabled();
    await button("重试确认授权提交").click();
  }
  await expect(active(".asset-portrait-message")).toContainText("等待交付经理确认");
  await expect(active(".asset-detail")).toContainText("肖像授权材料 2 份");
  await expect(active(".asset-detail")).toContainText("尚未确认");
  const submitted = (await calls()).filter((call) => call.path.endsWith("/portrait-auth"));
  expect(submitted).toHaveLength(scene.includes("unknown") ? 2 : 1);
  expect(submitted[0].data.fileIds).toHaveLength(2);
  if (submitted.length === 2) expect(submitted[1]).toEqual(submitted[0]);
  expect(
    (await calls())
      .filter((call) => call.path === "/m/files")
      .every((call) => call.data.category === "portrait_auth"),
  ).toBe(true);
  expect((await calls()).filter((call) => call.method === "GET").length).toBeGreaterThan(1);
}
