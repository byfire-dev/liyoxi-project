import { expect, test } from "@playwright/test";
import { noHorizontalScroll, recordErrors } from "./live-context";
import { orderFixture, orderShot as shot } from "./live-order-fixture";
test("订购单真实筛选计数、单号详情与刷新严格解析", async ({ page }) => {
  const errors = recordErrors(page),
    fixture = orderFixture(),
    pending = fixture.orders[0]!;
  await page.goto("/orders?q=订单演练");
  await expect(page.getByRole("heading", { name: "订购单", exact: true })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);
  await shot(page, "orders-01-list");
  await page.getByRole("tab", { name: /待开工/ }).click();
  await expect(page).toHaveURL(/tab=pending_start/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText(pending.name);
  await table.getByRole("button", { name: pending.orderNo, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${pending.orderNo}$`));
  await expect(
    page.getByRole("heading", { name: `订购单 ${pending.orderNo}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "积分明细", exact: true })).toBeVisible();
  await expect(page.getByText("尚未开工", { exact: true })).toBeVisible();
  await shot(page, "orders-02-detail");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: `订购单 ${pending.orderNo}`, exact: true }),
  ).toBeVisible();
  await page.goto(`/orders/${pending.orderNo.slice(0, -1)}`);
  await expect(page.getByText("没有找到这张订购单", { exact: true })).toBeVisible();
  await noHorizontalScroll(page, "严格单号404");
  expect(errors).toEqual([]);
});
