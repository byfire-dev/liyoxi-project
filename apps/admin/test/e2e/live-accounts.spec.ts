import { expect, test, type Page } from "@playwright/test";
import { noHorizontalScroll, recordErrors } from "./live-context";
import { accountFixtureImage, orderFixture, orderShot } from "./live-order-fixture";
async function compare(page: Page, name: string, uid: string, mismatch = false) {
  await page.getByRole("textbox", { name: "账号名称识别值", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "账号 ID识别值", exact: true }).fill(uid);
  await page.getByRole("combobox", { name: "账号类型识别值", exact: true }).click();
  await page.getByTitle("未认证", { exact: true }).click();
  await page.getByRole("textbox", { name: "账号状态识别值", exact: true }).fill("正常");
  for (const field of ["账号名称", "账号 ID", "账号类型", "认证主体", "账号状态"])
    await page
      .getByRole("radiogroup", { name: `${field}核对结论`, exact: true })
      .getByRole("radio", {
        name: mismatch && field === "账号名称" ? "不一致" : "一致",
        exact: true,
      })
      .check();
}
test("账号真实人工核验：30秒静默读、通过下一条、驳回必选原因且双提交仅一次", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = orderFixture(),
    [first, second] = fixture.accounts;
  if (!first || !second) throw new Error("账号演练数据缺失");
  const errors = recordErrors(page),
    fileIds = fixture.accounts.map((row) => row.fileId);
  expect(
    accountFixtureImage(new URL(`https://other.invalid/asset/test/${first.fileId}.jpg`), fileIds),
  ).toBe(false);
  expect(
    accountFixtureImage(new URL("https://fake-storage.invalid/asset/test/neighbor.jpg"), fileIds),
  ).toBe(false);
  await page.route(
    (url) => accountFixtureImage(url, fileIds),
    (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="white"/><text x="18" y="55" font-size="20">账号主页演练图</text><text x="18" y="95" font-size="14">仅用于本地接口验收</text><text x="18" y="135" font-size="16">账号 ID：lyx_demo</text><text x="18" y="180" font-size="16">账号类型：未认证</text><text x="18" y="225" font-size="16">状态：正常</text></svg>',
      }),
  );
  let polls = 0,
    queueReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      ["/api/v1/admin/approvals", "/api/v1/admin/approvals/summary"].includes(url.pathname) &&
      url.searchParams.get("kind") === "channel_account"
    ) {
      queueReads++;
      if (url.pathname === "/api/v1/admin/approvals") polls++;
    }
  });
  await page.goto("/publish/accounts?q=账号演练");
  await expect(page.getByRole("heading", { name: "账号核验", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: first.name, exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "账号主页截图 1", exact: true })).toBeVisible();
  await compare(page, first.name, "lyx_demo_1");
  await expect(page.getByRole("button", { name: "通过", exact: true })).toBeDisabled();
  for (const checkbox of await page.locator(".lyx-checklist").getByRole("checkbox").all())
    await checkbox.check();
  await orderShot(page, "accounts-01-compare");
  const beforePoll = polls;
  await expect.poll(() => polls, { timeout: 40_000 }).toBeGreaterThan(beforePoll);
  await expect(page.getByRole("textbox", { name: "账号名称识别值", exact: true })).toHaveValue(
    first.name,
  );
  const background = await page.context().newPage();
  await background.goto("about:blank");
  await background.bringToFront();
  const browserHidden = await page.evaluate(() => document.visibilityState === "hidden");
  if (!browserHidden)
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  test.info().annotations.push({
    type: "queue-visibility",
    description: browserHidden
      ? "浏览器真实切换 tab 的 hidden 状态"
      : "headless 不隐藏 tab；限定本页 visibilityState getter 与真实 visibilitychange 的依赖探针",
  });
  await page.waitForTimeout(1_000);
  const hiddenReads = queueReads;
  await page.waitForTimeout(31_000);
  expect(queueReads).toBe(hiddenReads);
  await page.bringToFront();
  if (!browserHidden)
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await expect.poll(() => queueReads).toBeGreaterThan(hiddenReads);
  await expect(page.getByRole("textbox", { name: "账号名称识别值", exact: true })).toHaveValue(
    first.name,
  );
  await background.close();
  let approves = 0,
    rejects = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/approve")) approves++;
    if (request.method() === "POST" && request.url().endsWith("/reject")) rejects++;
  });
  await page.getByRole("button", { name: "通过", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("heading", { name: second.name, exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /待核验.*1/ })).toBeVisible();
  expect(approves).toBe(1);
  await expect(page.getByRole("textbox", { name: "账号名称识别值", exact: true })).toHaveValue("");
  await compare(page, "截图名称不一致", "lyx_demo_2", true);
  await page.getByRole("button", { name: "驳回", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "驳回账号核验", exact: true });
  await expect(dialog.getByRole("button", { name: "确认驳回", exact: true })).toBeDisabled();
  await dialog.getByRole("radio", { name: "账号名称不一致", exact: true }).check();
  await dialog
    .getByRole("textbox", { name: "驳回说明", exact: true })
    .fill("主页截图中的账号名称与提交资料不同，请核对后重新提交");
  await orderShot(page, "accounts-02-reject");
  await dialog.getByRole("button", { name: "确认驳回", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("暂无待核验账号", { exact: true })).toBeVisible();
  expect(rejects).toBe(1);
  await noHorizontalScroll(page, "账号核验处理完成");
  expect(errors).toEqual([]);
});
