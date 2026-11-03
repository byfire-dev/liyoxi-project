import { expect } from "@playwright/test";

const PRO = "00000000-0000-4000-8000-000000000001";
const FLAGSHIP = "00000000-0000-4000-8000-000000000103";

export async function runPlanPickRegression(page, scene) {
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const body = active(".billing-plan");
  const calls = () => page.evaluate(() => globalThis.__LYX_PLAN_CALLS__ ?? []);
  const quotes = async () => (await calls()).filter((call) => call.path === "/m/plans/quote");
  const options = active(".billing-plan__stack .lyx-option-card");
  const skeleton = active(".billing-plan .lyx-skeleton");
  const footer = active(".billing-plan .lyx-footer-bar");
  const mode = (label) => active(".billing-plan__cycles .lyx-button").filter({ hasText: label });
  await expect(active("#billing-ready")).toBeVisible();

  if (scene === "wallet-upgrade-highest") {
    const wallet = active(".billing-wallet");
    await expect(wallet).toContainText("旗舰版");
    await expect(wallet).toContainText("当前已是最高档");
    await expect(wallet.locator(".lyx-button").filter({ hasText: "立即升级" })).toHaveCount(0);
    await expect(
      wallet.locator(".lyx-button").filter({ hasText: "续费 / 下期变更" }),
    ).toBeVisible();
    await expect(wallet.locator(".lyx-skeleton")).toHaveCount(0);
    expect((await calls()).some((call) => call.path === "/m/plans")).toBe(true);
    expect(await quotes()).toHaveLength(0);
    return;
  }

  if (scene === "plan-upgrade-highest") {
    await expect(body).toContainText("当前已是最高档");
    await expect(skeleton).toHaveCount(0);
    await expect(footer).toHaveCount(0);
    await expect(options).toHaveCount(0);
    expect(await quotes()).toHaveLength(0);
    // 最高档仍能切到续费，不能因空升级列表把整个页面锁死。
    await mode("续费 / 下期变更").click();
    await expect(body).toContainText("旗舰版续费，下期生效");
    await expect(footer).toBeVisible();
    const renewal = await quotes();
    expect(renewal).toHaveLength(1);
    expect(renewal[0].data).toEqual({ planId: FLAGSHIP, intent: "renew_next_term", months: 1 });
    await mode("立即升级").click();
    await expect(body).toContainText("当前已是最高档");
    await expect(skeleton).toHaveCount(0);
    await expect(footer).toHaveCount(0);
    expect(await quotes()).toHaveLength(1);
  } else {
    if (scene === "plan-upgrade-retry") {
      await expect(body).toContainText("报价服务暂时不可用，请重试");
      await expect(skeleton).toHaveCount(0);
      await expect(footer).toHaveCount(0);
      expect(await quotes()).toHaveLength(1);
      await active(".billing-plan .lyx-empty .lyx-button").click();
    }
    await expect(footer).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    await expect(body).toContainText("本次变更");
    await expect(body).not.toContainText("报价服务暂时不可用，请重试");
    const evidence = await quotes();
    expect(evidence).toHaveLength(scene === "plan-upgrade-retry" ? 2 : 1);
    const upgrade = scene !== "plan-renew";
    const expectedPlan = scene === "plan-upgrade" || !upgrade ? PRO : FLAGSHIP;
    for (const call of evidence) {
      expect(call.method).toBe("POST");
      expect(call.data).toEqual({
        planId: expectedPlan,
        intent: upgrade ? "upgrade_now" : "renew_next_term",
        ...(upgrade ? {} : { months: 1 }),
      });
    }
    if (scene === "plan-upgrade-middle" || scene === "plan-upgrade-retry") {
      await expect(options).toHaveCount(1);
      await expect(options).toContainText("旗舰版");
      await expect(body).toContainText("专业版升级至旗舰版");
      await expect(footer).toContainText("¥800");
    }
  }
  expect((await calls()).some((call) => call.path.startsWith("/m/payment-orders"))).toBe(false);
}
