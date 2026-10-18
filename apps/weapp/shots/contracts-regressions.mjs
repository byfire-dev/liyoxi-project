import { expect } from "@playwright/test";

export async function runContractsRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  await expect(active("#contracts-ready")).toBeVisible();
  await expect(active(".billing-contracts")).toContainText("2026-08-01 10:30");
  const calls = () => page.evaluate(() => globalThis.__LYX_CONTRACT_CALLS__ ?? []);
  if (scene === "contracts-clerk") {
    await expect(active(".billing-contracts")).toContainText("仅展示本人");
    await expect(active(".billing-contracts")).not.toContainText("关联单号");
    await expect(active(".billing-contracts")).not.toContainText("单据内容");
    expect((await calls()).some((call) => call.path.endsWith("/summary"))).toBe(false);
  } else {
    await expect(active(".billing-contracts")).toContainText("前任老板");
    await expect(active(".billing-contracts")).toContainText("开通签署时专业版");
  }
  await active(".billing-contracts .lyx-text-button")
    .filter({ hasText: "查看所签版本" })
    .first()
    .click();
  if (scene === "contracts-clerk") {
    await expect(active(".lyx-sheet__title")).toHaveText("商家服务协议");
    await expect(active(".lyx-sheet")).toContainText("本人确认的用户协议");
    await expect(active(".lyx-sheet")).toContainText("注册、登录与使用规则");
    await expect(active(".lyx-sheet")).not.toContainText("套餐服务协议");
    await expect(active(".lyx-sheet")).not.toContainText("付款单和套餐内容");
  } else await expect(active(".lyx-sheet")).toContainText("签署时的服务约定");
  await expect(active(".lyx-sheet")).toContainText("v1.0");
  await expect(active(".lyx-sheet")).toContainText("2026-08-01 10:30 生效");
  await expect(active(".lyx-sheet")).toContainText("历史版本");
  const open = active(".lyx-sheet .lyx-button").filter({ hasText: "打开所签版本 PDF" });
  await open.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis.__LYX_CONTRACT_DOCUMENTS__ ?? []).filter((item) => item === "open").length,
      ),
    )
    .toBe(1);
  await expect(open).not.toHaveClass(/loading/);
  await open.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis.__LYX_CONTRACT_DOCUMENTS__ ?? []).filter((item) => item === "open").length,
      ),
    )
    .toBe(2);
  const evidence = await calls();
  const versions = evidence.filter((call) => call.path.includes("/agreement-versions/"));
  expect(versions).toHaveLength(3);
  const versionId =
    scene === "contracts-clerk"
      ? "00000000-0000-4000-8000-000000000043"
      : "00000000-0000-4000-8000-000000000041";
  expect(versions.every((call) => call.path === `/m/agreement-versions/${versionId}`)).toBe(true);
  expect(evidence.every((call) => call.method === "GET")).toBe(true);
}
