import { expect } from "@playwright/test";

/** Observe page requests and fixture receipts separately; no real API or device claim. */
export async function portalSessionRegression(page, scene) {
  const settledSheets = async () => {
    await expect
      .poll(() =>
        page.locator(".lyx-sheet-popup, .lyx-sheet-overlay").evaluateAll((nodes) =>
          nodes.every((node) => {
            if (!node.getClientRects().length) return true;
            const stillMoving = node
              .getAnimations()
              .some((animation) => animation.playState === "running" || animation.pending);
            return (
              !stillMoving &&
              (!node.matches(".lyx-sheet-popup") ||
                node.getBoundingClientRect().bottom <= globalThis.innerHeight + 1)
            );
          }),
        ),
      )
      .toBe(true);
  };
  const active = (selector) =>
    page.locator(".taro_page_stationed:not(.taro_page_shade)").locator(selector);
  const sheet = active(".lyx-sheet").filter({
    has: page.locator(":scope > .lyx-sheet__header .lyx-sheet__title", {
      hasText: /^已授权的电脑$/,
    }),
  });
  const confirmation = active(".lyx-sheet").filter({
    has: page.locator(":scope > .lyx-sheet__header .lyx-sheet__title", {
      hasText: /^撤销电脑授权？$/,
    }),
  });
  const calls = async () =>
    (await page.evaluate(() => globalThis.__LYX_SETTINGS_CALLS__ ?? [])).filter((call) =>
      call.path.startsWith("/m/portal-sessions"),
    );
  await active(".settings-page .lyx-list-row").filter({ hasText: "已授权的电脑" }).click();
  await expect(sheet).toBeVisible();
  await settledSheets();
  for (const name of ["授权电脑", "输入授权码", "刷新电脑列表"])
    await expect(
      sheet.locator(".lyx-button").filter({ hasText: new RegExp(`^${name}$`) }),
    ).toBeVisible();
  if (scene === "settings-portals-error") {
    await expect(sheet).toContainText("电脑授权列表暂时不可用");
    await expect(sheet).not.toContainText("暂无有效电脑授权");
    expect(await calls()).toEqual([{ path: "/m/portal-sessions", method: "GET" }]);
    return;
  }
  if (scene === "settings-portals-empty") {
    await expect(sheet).toContainText("暂无有效电脑授权");
    await expect(sheet.locator(".lyx-list-row")).toHaveCount(0);
  } else {
    await expect(sheet).toContainText("Chrome · macOS");
    await expect(sheet).toContainText("Edge · Windows");
    await expect(sheet).toContainText("邻里咖啡 · 福田店");
    await expect(sheet).toContainText("南山店");
    await expect(sheet.locator(".lyx-list-row")).toHaveCount(2);
  }
  expect(await calls()).toEqual([{ path: "/m/portal-sessions", method: "GET" }]);
  if (!["settings-portals-revoke-confirm", "settings-portals-revoked"].includes(scene)) return;
  await sheet
    .locator(".lyx-list-row")
    .filter({ hasText: "Chrome · macOS" })
    .locator(".lyx-text-button")
    .click();
  await expect(confirmation).toBeVisible();
  await settledSheets();
  await expect(confirmation).toContainText("其他电脑和小程序登录不受影响");
  const submit = confirmation.locator(".lyx-button").filter({ hasText: /^确认撤销授权$/ });
  await expect(submit).toHaveClass(/lyx-button--disabled/);
  expect((await calls()).filter((call) => call.method === "POST")).toHaveLength(0);
  await confirmation
    .locator(".lyx-checkbox")
    .filter({ hasText: "我已核对这台电脑，确认撤销授权" })
    .click();
  await expect(submit).not.toHaveClass(/lyx-button--disabled/);
  if (scene === "settings-portals-revoke-confirm") return;
  await submit.click();
  await expect(confirmation).toBeHidden();
  await settledSheets();
  await expect(sheet).toContainText("撤销授权");
  await expect(sheet.locator('[role="status"]').filter({ hasText: "已于" })).toContainText(
    "撤销授权",
  );
  await expect(sheet.locator(".lyx-list-row")).toHaveCount(1);
  await expect(sheet.locator(".lyx-list-row")).toContainText("Edge · Windows");
  await expect(sheet.locator(".lyx-list-row")).not.toContainText("Chrome · macOS");
  const history = await calls();
  expect(history.map((call) => [call.path, call.method])).toEqual([
    ["/m/portal-sessions", "GET"],
    ["/m/portal-sessions/019a4500-0000-7000-8000-000000000300/revoke", "POST"],
    ["/m/portal-sessions", "GET"],
  ]);
  expect(history[1].key).toBeTruthy();
}
