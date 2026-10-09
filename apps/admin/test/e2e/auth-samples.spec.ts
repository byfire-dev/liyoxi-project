import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createSampleBackend, type SampleBackend } from "../../src/dev/sample-backend";

async function serve(page: Page, backend: SampleBackend) {
  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
}
async function shot(page: Page, name: string) {
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
test("再验证共用一个弹层、重放保留幂等键；403、404和用户菜单", async ({ page }) => {
  const backend = createSampleBackend();
  await serve(page, backend);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("status of 403"))
      errors.push(message.text());
  });
  await page.goto("/dev/table");
  await expect(page.getByRole("region", { name: "商家列表" })).toBeVisible();
  await page.getByRole("button", { name: "验证敏感操作" }).click();
  const dialog = page.getByRole("dialog", { name: "验证身份后继续" });
  await expect(dialog).toHaveCount(1);
  await expect
    .poll(() => backend.received.filter((item) => item.path.endsWith("step-up-check")).length)
    .toBe(2);
  await shot(page, "auth-06-step-up");
  await dialog.getByRole("textbox", { name: "6 位动态口令" }).fill("123456");
  await dialog.getByRole("button", { name: "验证并继续" }).click();
  await expect(page.getByRole("status").filter({ hasText: "两个操作已完成" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  const requests = backend.received.filter((item) => item.path.endsWith("step-up-check"));
  expect(requests).toHaveLength(4);
  const keys = requests.map((item) => item.headers["idempotency-key"]);
  expect(new Set(keys).size).toBe(2);
  expect(keys.slice(0, 2).sort()).toEqual(keys.slice(2).sort());
  expect(backend.received.filter((item) => item.path.endsWith("/auth/step-up"))).toHaveLength(1);
  await page.getByRole("button", { name: "用户菜单" }).click();
  await expect(page.getByRole("menuitem", { name: "退出登录" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "修改密码" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "动态口令设置" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "绑定企业微信" })).toBeVisible();
  await shot(page, "auth-09-user-menu");
  await page.keyboard.press("Escape");
  await page.evaluate(() => localStorage.setItem("lyx.dev.role", "service"));
  await page.goto("/sys/staff");
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.getByRole("heading", { name: "没有访问权限" })).toBeVisible();
  await shot(page, "auth-07-forbidden");
  await page.goto("/missing-page");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await shot(page, "auth-08-not-found");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("绑定使用新票据有效期，旧票据到期后继续填写且字段显示计数", async ({ page }) => {
  const now = new Date("2026-10-06T06:00:00Z");
  await page.clock.install({ time: now });
  let enrollCalls = 0;
  await page.route("**/api/v1/admin/auth/**", async (route) => {
    const enrollment = route.request().url().endsWith("/enroll-totp");
    if (enrollment) enrollCalls++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: enrollment
          ? {
              ticket: "renewed-enrollment-ticket",
              ticketExpiresAt: new Date(now.getTime() + 900_000).toISOString(),
              secret: "JBSWY3DPEHPK3PXP",
              otpauthUri: "otpauth://totp/Liyoxi:test?secret=JBSWY3DPEHPK3PXP&issuer=Liyoxi",
            }
          : {
              next: "enroll_totp",
              ticket: "short-login-ticket",
              ticketExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
            },
      }),
    });
  });
  await page.goto("/login");
  await page.getByRole("textbox", { name: "手机号" }).fill("13800138001");
  await page.getByLabel("密码", { exact: true }).fill("Liyoxi-2026-ok");
  await expect(page.getByText("11/11", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "手输密钥" })).toHaveValue("JBSWY3DPEHPK3PXP");
  await page.clock.fastForward(61_000);
  await page.getByRole("textbox", { name: "6 位动态口令" }).fill("123456");
  await expect(page.getByText("6/6", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login\/enroll-totp/);
  expect(enrollCalls).toBe(1);
  await page.clock.fastForward(900_000);
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByRole("heading", { name: "登录后台" })).toBeVisible();
});
