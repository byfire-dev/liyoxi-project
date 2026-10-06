// 后续 live-*.spec.ts 自动依赖一次登录准备，复用真实会话，不逐条再登录。
import { expect, test } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";

test("新浏览器上下文复用准备阶段的登录态", async ({ page }) => {
  const context = liveContext();
  const errors = recordErrors(page);
  await page.goto("/orders");
  await expect(page.getByRole("button", { name: "用户菜单" })).toContainText(context.name);
  const response = await page.request.get("/api/v1/admin/auth/me");
  expect(response.status()).toBe(200);
  expect((await response.json()).data.staff.roleKey).toBe("super_admin");
  await noHorizontalScroll(page, "复用登录态");
  expect(errors).toEqual([]);
});
