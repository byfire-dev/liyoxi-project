import { expect } from "@playwright/test";

export async function runLedgerRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const calls = () => page.evaluate(() => globalThis.__LYX_LEDGER_CALLS__ ?? []);
  if (scene === "ledger-entry") {
    await active(".billing-wallet .lyx-text-button").filter({ hasText: "积分明细" }).click();
    await expect(active("#ledger-ready")).toBeVisible();
    await expect(active(".billing-ledger__row")).toHaveCount(3);
  } else if (scene === "ledger-loading") {
    await expect(active(".billing-ledger .lyx-skeleton")).toBeVisible();
    await expect(active(".billing-ledger .lyx-empty")).toHaveCount(0);
  } else if (scene === "ledger-clerk" || scene === "ledger-forbidden") {
    await expect(active(".billing-ledger")).toContainText("当前身份无法查看积分流水");
    await expect(active(".billing-ledger__row")).toHaveCount(0);
    await expect(active(".billing-ledger .lyx-tabs")).toHaveCount(0);
    expect(await calls()).toHaveLength(scene === "ledger-clerk" ? 0 : 1);
  } else if (scene === "ledger-empty") {
    await expect(active(".billing-ledger")).toContainText("本月没有此类记录");
    await expect(active(".billing-ledger__row")).toHaveCount(0);
    await expect(active(".billing-ledger")).not.toContainText("暂时无法加载");
  } else if (scene === "ledger-error") {
    await expect(active(".billing-ledger")).toContainText("暂时无法加载积分流水，请重试");
    await expect(
      active(".billing-ledger .lyx-button").filter({ hasText: "重新加载" }),
    ).toBeVisible();
    await expect(active(".billing-ledger__row")).toHaveCount(0);
    await expect(active(".billing-ledger")).not.toContainText("本月没有此类记录");
  } else if (scene === "ledger-more") {
    const more = () => active(".billing-ledger .lyx-button").filter({ hasText: "加载更多" });
    await expect(active(".billing-ledger__row")).toHaveCount(1);
    await more().click();
    await expect(active(".billing-ledger__row")).toHaveCount(2);
    await expect(more()).toHaveCount(0);
    let evidence = await calls();
    expect(new URL(evidence.at(-1).path, "https://local.invalid").searchParams.get("cursor")).toBe(
      "opaque+/=page2",
    );
    await active(".billing-ledger .lyx-text-button")
      .filter({ hasText: /^刷新$/ })
      .click();
    await expect(active(".billing-ledger__row")).toHaveCount(1);
    evidence = await calls();
    expect(new URL(evidence.at(-1).path, "https://local.invalid").searchParams.has("cursor")).toBe(
      false,
    );
    await more().click();
    await expect(active(".billing-ledger__row")).toHaveCount(2);
  } else if (scene === "ledger-filters") {
    await active(".lyx-tabs__item").filter({ hasText: "使用" }).click();
    await expect(active(".billing-ledger__row")).toHaveCount(1);
    await expect(active(".billing-ledger__row")).toContainText("订购《巷口那家店》");
    await active(".billing-ledger .lyx-button").filter({ hasText: "查看 2026-09 记录" }).click();
    await expect(active(".billing-ledger__month")).toHaveText("2026-09 积分流水");
    await active(".billing-ledger .lyx-text-button").filter({ hasText: "清除筛选" }).click();
    await expect(active(".billing-ledger__row")).toContainText("发放本期套餐积分");
    await expect(active(".lyx-tabs__item--active")).toHaveText("全部");
    const evidence = await calls();
    const queries = evidence.map(
      (call) => new URL(call.path, "https://local.invalid").searchParams,
    );
    expect(queries.some((q) => q.get("month") === "2026-09" && q.get("tab") === "use")).toBe(true);
    expect(queries.every((q) => !q.has("cursor"))).toBe(true);
    expect(queries.at(-1).get("month")).toBe(queries[0].get("month"));
  } else {
    await expect(active(".billing-ledger__row")).toHaveCount(3);
    await expect(active(".billing-ledger__points").last()).toHaveText("0");
    await expect(active(".billing-ledger")).toContainText("10-01 00:00");
    await expect(active(".billing-ledger")).toContainText("LYX202610010000001");
    await expect(active(".billing-ledger")).not.toContainText("¥");
  }
  expect((await calls()).every((call) => call.method === "GET")).toBe(true);
}
