import { expect, test } from "@playwright/test";

import { createSampleBackend } from "../../src/dev/sample-backend";
import { recordErrors } from "./live-context";

test("有列表和汇总查询的页面退出后不重建受保护查询", async ({ page }) => {
  const backend = createSampleBackend();
  const errors = recordErrors(page);
  const afterLogout: string[] = [];
  let logoutCalls = 0;
  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/admin/sessions/current") {
      expect(request.method()).toBe("DELETE");
      logoutCalls++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ code: 0, message: "ok", data: {} }),
      });
      return;
    }
    if (logoutCalls) afterLogout.push(url.pathname);
    const response = backend.handle({
      method: request.method(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers(),
      body: request.postDataJSON() as unknown,
    });
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
  await page.goto("/dev/table");
  await expect(page.getByRole("region", { name: "商家列表" })).toBeVisible();
  await expect.poll(() => backend.received.filter((row) => row.method === "GET").length).toBe(2);
  await page.getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "登录后台" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(logoutCalls).toBe(1);
  expect(afterLogout).toEqual([]);
  expect(errors).toEqual([]);
});
