import { expect } from "@playwright/test";

export async function runTopupRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const body = active(".billing-topup");
  const calls = () => page.evaluate(() => globalThis.__LYX_TOPUP_CALLS__ ?? []);
  const payments = active(".billing-topup .lyx-footer-bar .lyx-button");
  const agreementCalls = async () =>
    (await calls()).filter(
      (call) => new URL(call.path, "https://fixture.invalid").pathname === "/m/agreements",
    );
  await expect(active("#topup-ready")).toBeVisible();

  if (scene === "topup-clerk") {
    await expect(body).toContainText("当前身份无法加购积分");
    expect(await calls()).toHaveLength(0);
    return;
  }
  if (scene === "topup-offline" || scene === "topup-hidden") {
    await expect(body).toContainText("暂未开放在线购买");
    await expect(payments).toHaveCount(0);
    expect(await agreementCalls()).toHaveLength(0);
  } else if (scene === "topup-error") {
    await expect(body).toContainText("暂时无法加载积分包，请重试");
    await expect(payments).toHaveCount(0);
  } else if (scene === "topup-disabled") {
    await expect(body).toContainText("付款方式暂未配置，请联系服务经理");
    await expect(payments).toHaveCount(0);
    await expect(body).not.toContainText("购买协议暂未加载完整");
  } else {
    await expect(payments).toHaveCount(2);
    if (scene.startsWith("topup-agreements-")) {
      await expect(body).toContainText("购买协议暂未加载完整");
      for (const button of await payments.all())
        await expect(button).toHaveClass(/lyx-button--disabled/);
      expect(await agreementCalls()).toHaveLength(1);
      if (scene === "topup-agreements-retry") {
        await body.locator(".lyx-text-button").filter({ hasText: "重新加载购买协议" }).click();
        await expect(body).not.toContainText("购买协议暂未加载完整");
        expect(await agreementCalls()).toHaveLength(2);
      }
    }
    if (scene !== "topup-agreements-missing") {
      await expect(body).not.toContainText("购买协议暂未加载完整");
      await expect(body).toContainText("积分使用规则");
      await expect(body).not.toContainText("套餐服务协议");
      for (const button of await payments.all())
        await expect(button).not.toHaveClass(/lyx-button--disabled/);
      await payments.filter({ hasText: "微信支付" }).click();
      const confirmation = active(".lyx-sheet").filter({
        has: page.locator(".lyx-sheet__title", { hasText: "确认加购积分" }),
      });
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText("积分使用规则");
      await expect(confirmation).not.toContainText("套餐服务协议");
      await expect(confirmation).toContainText("1,000 积分");
      await expect(confirmation).toContainText("¥99");
      await confirmation.locator(".lyx-sheet__close").click();
      await expect(confirmation).not.toBeVisible();
      await expect(active(".lyx-sheet-overlay")).not.toBeVisible();
    }
  }

  const evidence = await calls();
  const policies = evidence.filter(
    (call) => new URL(call.path, "https://fixture.invalid").pathname === "/m/purchase-policy",
  );
  expect(policies.length).toBeGreaterThan(0);
  expect(
    policies.every(
      (call) => new URL(call.path, "https://fixture.invalid").searchParams.get("type") === "topup",
    ),
  ).toBe(true);
  expect(
    (await agreementCalls()).every(
      (call) => new URL(call.path, "https://fixture.invalid").searchParams.get("scene") === "topup",
    ),
  ).toBe(true);
  expect(evidence.every((call) => call.method === "GET")).toBe(true);
  expect(evidence.some((call) => call.path.startsWith("/m/payment-orders"))).toBe(false);
}
