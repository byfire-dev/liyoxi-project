import { expect } from "@playwright/test";

export async function settingsRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const row = (title) => active(".settings-page .lyx-list-row").filter({ hasText: title });
  const button = (title) => active(".lyx-button").filter({ hasText: new RegExp(`^${title}$`) });
  const calls = () => page.evaluate(() => globalThis.__LYX_SETTINGS_CALLS__ ?? []);
  await expect(active(".settings-page#settings-ready")).toBeVisible();
  await expect(row("已授权的电脑")).toContainText("暂未开放");
  expect((await calls()).some((call) => /portal/.test(call.path))).toBe(false);
  if (scene === "settings-guest") {
    await expect(active(".settings-page")).toContainText("登录后管理账号");
    expect((await calls()).some((call) => call.path === "/m/me")).toBe(false);
    await expect(row("隐私政策")).toBeVisible();
  } else if (scene === "settings-name-saved") {
    await row("本人称呼").click();
    await active(".lyx-sheet input").fill("新的本人称呼");
    await button("保存称呼").click();
    await expect(row("本人称呼")).toContainText("新的本人称呼");
    const writes = (await calls()).filter((call) => call.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBeTruthy();
  } else if (scene === "settings-delete-blocked") {
    await row("注销账号").click();
    await active(".lyx-sheet .lyx-checkbox").click();
    await button("确认注销账号").click();
    for (const text of [
      "生效套餐",
      "未完结付款",
      "未完结退款",
      "未完结开票",
      "在办订购",
      "上线中的成片",
    ])
      await expect(active(".lyx-sheet")).toContainText(text);
    expect((await calls()).filter((call) => call.path === "/m/me/deletion")).toHaveLength(1);
  } else if (scene === "settings-notice-retry") {
    await active(".settings-page .lyx-text-button").filter({ hasText: "关闭这条提示" }).click();
    await expect(active(".settings-page__error")).toContainText("网络暂不可用");
    await expect(active(".settings-page")).toContainText("账号刚在另一台设备登录");
    await active(".settings-page .lyx-text-button").filter({ hasText: "关闭这条提示" }).click();
    await expect(active(".settings-page")).not.toContainText("账号刚在另一台设备登录");
    const writes = (await calls()).filter((call) => call.path.includes("/user-notices/"));
    expect(writes).toHaveLength(2);
    expect(writes[1].key).toBe(writes[0].key);
  } else if (scene === "settings-phone-unavailable") {
    await expect(row("手机号")).toContainText("暂不支持自助换绑");
    await row("手机号").click();
    expect((await calls()).some((call) => call.path === "/m/sms-codes")).toBe(false);
  } else if (scene === "settings-identities") {
    const identitiesSheet = active(".lyx-sheet").filter({
      has: page.locator(".lyx-sheet__title", { hasText: /^已登录的微信$/ }),
    });
    const confirmationSheet = active(".lyx-sheet").filter({
      has: page.locator(".lyx-sheet__title", { hasText: /^移除此登录身份？$/ }),
    });
    await row("已登录的微信").click();
    await expect(identitiesSheet).toContainText("另一台手机");
    await identitiesSheet
      .locator(".lyx-list-row")
      .filter({ hasText: "另一台手机" })
      .locator(".lyx-text-button")
      .click();
    await button("确认移除").click();
    await expect(confirmationSheet).toBeHidden();
    await expect(identitiesSheet).not.toContainText("另一台手机");
    expect((await calls()).filter((call) => call.method === "DELETE")).toHaveLength(1);
  } else {
    await expect(row("本人称呼")).toBeVisible();
    await expect(row("退出登录")).toBeVisible();
  }
}
