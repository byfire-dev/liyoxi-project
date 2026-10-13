import { expect } from "@playwright/test";
export async function orderReferenceRegression(page, scene, origin) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const calls = () => page.evaluate(() => globalThis.__LYX_ORDER_REFERENCE_CALLS__ ?? []);
  const pick = (title) =>
    active(".order-reference-picker .lyx-checkbox").filter({ hasText: title });
  await expect(pick("门店日常实拍")).toBeVisible();
  if (scene.endsWith("scope")) {
    await page.evaluate(() => globalThis.__LYX_ORDER_REFERENCE_CONTROL__.hold());
    const reads = (await calls()).filter((call) => call.path.startsWith("/m/store-assets?")).length;
    await active(".order-reference-picker .lyx-text-button")
      .filter({ hasText: /^刷新参考素材$/ })
      .click();
    await expect
      .poll(
        async () =>
          (await calls()).filter((call) => call.path.startsWith("/m/store-assets?")).length,
      )
      .toBe(reads + 1);
    await page.evaluate(() => {
      globalThis.__LYX_ORDER_REFERENCE_CONTROL__.switchStore();
    });
    await page.evaluate(() => globalThis.__LYX_ORDER_REFERENCE_CONTROL__.release());
    await expect(pick("新门店独立素材")).toBeVisible();
    await expect(pick("门店日常实拍")).toHaveCount(0);
    await expect(active(".order-reference-picker")).toContainText("已选 0/9");
    return;
  }
  const invalid = pick("当前不可参考素材");
  await expect(invalid).toHaveClass(/lyx-checkbox--disabled/);
  await invalid.click({ force: true });
  await expect(active(".order-reference-picker")).toContainText("已选 0/9");
  await pick("门店日常实拍").click();
  if (scene.endsWith("submit")) await pick("员工服务记录").click();
  await active(".checkout-page .lyx-checkbox").filter({ hasText: "抖音 · 邻里咖啡" }).click();
  await expect(active(".checkout-page#order-ready")).toBeVisible();
  await active(".checkout-page .lyx-chip").filter({ hasText: "主推服务" }).click();
  await active(".checkout-page .lyx-checkbox")
    .filter({ hasText: "我已阅读并同意本次协议" })
    .click();
  const submit = active(".checkout-page .lyx-footer-bar .lyx-button");
  await submit.click();
  await expect(active(".checkout-page")).toContainText("网络暂时中断，请重试");
  await submit.click();
  await expect(page.getByText("订购成功", { exact: true })).toBeVisible();
  const writes = (await calls()).filter(
    (call) => call.path === "/m/orders" && call.method === "POST",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  const expected = [
    "019aa000-0000-7000-8000-000000000031",
    ...(scene.endsWith("submit") ? ["019aa000-0000-7000-8000-000000000032"] : []),
  ];
  expect(writes[0].data.referenceStoreAssetIds).toEqual(expected);
  expect(writes[0].data.expect.totalChargePoints).toBe(900);
  const quotes = (await calls()).filter((call) => call.path === "/m/orders/quote");
  expect(quotes.every((call) => call.data.referenceStoreAssetIds === undefined)).toBe(true);
  await page.goto(
    `${origin}/#/sub/order/order-detail/index?orderId=00000000-0000-4000-8000-000000000401`,
    { waitUntil: "networkidle" },
  );
  await expect(active(".order-reference-read")).toContainText("门店日常实拍");
  if (scene.endsWith("submit"))
    await expect(active(".order-reference-read")).toContainText("员工服务记录");
  const echoed = (await calls()).find((call) => call.path.startsWith("/m/store-assets?ids="));
  expect(new URL(echoed.path, origin).searchParams.get("ids")).toBe(expected.join(","));
}
