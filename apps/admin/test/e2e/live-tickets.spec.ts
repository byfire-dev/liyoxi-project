import { expect, test } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { orderFixture, orderShot } from "./live-order-fixture";
test("工单池真实指派：同步双点击仅一次，另一交付经理登录按本人范围查看", async ({
  page,
  browser,
}) => {
  const errors = recordErrors(page),
    fixture = orderFixture(),
    item = fixture.orders[1]!;
  await page.goto("/delivery/tickets?q=订单演练");
  await expect(page.getByRole("heading", { name: "工单池", exact: true })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("columnheader")).toHaveCount(10);
  await expect(table).toContainText("待分配");
  await orderShot(page, "tickets-01-pool");
  await table.getByRole("button", { name: "分配", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分配交付经理", exact: true });
  await dialog.getByRole("combobox", { name: "交付经理", exact: true }).click();
  await page.getByTitle(fixture.manager.name, { exact: true }).click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await dialog
    .getByRole("textbox", { name: "分配备注", exact: true })
    .fill("按门店已提交的要求安排制作");
  await orderShot(page, "tickets-02-assign");
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/assign-manager")) writes++;
  });
  await dialog.getByRole("button", { name: "确认分配", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(dialog).toHaveCount(0);
  await expect(table).toContainText("方案确认");
  await expect(table).toContainText(fixture.manager.name);
  expect(writes).toBe(1);
  const context = await browser.newContext({
    baseURL: liveContext().origin,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  try {
    const managerPage = await context.newPage(),
      managerErrors = recordErrors(managerPage);
    let staffReads = 0;
    managerPage.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/admin/staff")
        staffReads++;
    });
    await managerPage.goto(`/login?redirect=${encodeURIComponent("/delivery/tickets?q=订单演练")}`);
    await managerPage.getByLabel("手机号", { exact: true }).fill(fixture.manager.phone);
    await managerPage.getByLabel("密码", { exact: true }).fill(fixture.manager.password);
    await managerPage.getByRole("button", { name: "下一步", exact: true }).click();
    await managerPage.getByRole("radio", { name: "恢复码", exact: true }).check();
    await managerPage
      .getByRole("textbox", { name: "恢复码", exact: true })
      .fill(fixture.manager.recoveryCode);
    await managerPage.getByRole("button", { name: "登录", exact: true }).click();
    await expect(managerPage.getByRole("button", { name: "用户菜单" })).toContainText(
      fixture.manager.name,
    );
    await expect(managerPage.getByRole("table")).toContainText(item.name);
    await expect(
      managerPage.getByRole("table").getByRole("button", { name: "分配", exact: true }),
    ).toHaveCount(0);
    await noHorizontalScroll(managerPage, "交付经理本人工单池");
    expect(staffReads).toBe(0);
    expect(managerErrors).toEqual([]);
  } finally {
    await context.close();
  }
  await noHorizontalScroll(page, "工单分配完成");
  expect(errors).toEqual([]);
});
