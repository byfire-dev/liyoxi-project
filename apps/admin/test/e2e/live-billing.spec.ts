import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { formatMoneyFixed, fenToYuan } from "@liyoxi/shared/format/money";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
interface BillingFixture {
  items: {
    proofId: string;
    paymentOrderId: string;
    orderNo: string;
    entityName: string;
    amountFen: number;
  }[];
  addedStaffCount: number;
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
}
test("对公到账真API：金额初始空、勾选+流水+金额确认，队列/计数和下一条同步；驳回必填说明", async ({
  page,
}) => {
  const context = liveContext(),
    fixture = (context.fixtures as { fixtures: { billing: BillingFixture } }).fixtures.billing;
  expect(fixture.addedStaffCount).toBe(2);
  expect(fixture.items).toHaveLength(3);
  const errors = recordErrors(page),
    selected: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/transfer-proofs\/[^/]+\/confirm$/.test(new URL(request.url()).pathname)
    )
      selected.push(request.headers()["idempotency-key"]!);
  });
  await page.goto("/orders/receipts?q=到账演练");
  await expect(page.getByRole("heading", { name: "对公收款确认", exact: true })).toBeVisible();
  const queue = page.locator(".lyx-queue__list");
  await expect(queue.locator("[data-queue-item]")).toHaveCount(3);
  const amount = page.getByRole("textbox", { name: "实际到账金额（元）", exact: true });
  await expect(amount).toHaveValue("");
  await expect(page.getByLabel("付款行", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("未配置识别，请以银行账户的真实流水为准", { exact: true }),
  ).toBeVisible();
  const first = fixture.items.find((v) => page.url().includes(v.proofId)) ?? fixture.items[0]!;
  // 队列实际排序来自接口；读取当前详情回显的单号，按它选择真实 fixture 金额。
  const detail = page.locator(".lyx-queue__detail");
  const orderNo = (await detail.getByRole("button", { name: /^FK\d+$/ }).innerText()).trim();
  const target = fixture.items.find((v) => v.orderNo === orderNo)!;
  expect(target).toBeDefined();
  expect(first).toBeDefined();
  await shot(page, "receipts-01-queue-detail");
  await detail.getByRole("button", { name: target.orderNo, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "付款单详情", exact: true })).toContainText(
    formatMoneyFixed(target.amountFen),
  );
  await page
    .getByRole("dialog", { name: "付款单详情", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "已在银行账户中查到该笔到账流水" }).check();
  await page
    .getByRole("textbox", { name: "银行流水号", exact: true })
    .fill("LIVE-BILLING-20261006-ONE");
  await amount.fill(fenToYuan(target.amountFen));
  await shot(page, "receipts-02-confirm");
  const confirmed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/transfer-proofs/${target.proofId}/confirm`),
  );
  await page.getByRole("button", { name: "确认到账", exact: true }).click();
  const response = await confirmed;
  expect(response.status(), await response.text()).toBe(200);
  await expect(queue.locator("[data-queue-item]")).toHaveCount(2);
  await expect(detail.getByRole("button", { name: target.orderNo, exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /待确认/ })).toContainText("2");
  await expect(amount).toHaveValue("");
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatch(/^receipt-confirm:/);
  // 真接口读回付款单，证明这次点击实际到账履约，未用路由stub代替资金写。
  const orderResponse = await page.request.get(
    `/api/v1/admin/payment-orders/${target.paymentOrderId}`,
  );
  expect(orderResponse.status()).toBe(200);
  expect((await orderResponse.json()).data).toMatchObject({
    status: "paid",
    fulfillmentStatus: "done",
    paidAmountFen: target.amountFen,
  });
  await page.getByRole("button", { name: "驳回凭证", exact: true }).click();
  const reject = page.getByRole("dialog", { name: "驳回转账凭证", exact: true });
  await expect(reject.getByRole("button", { name: "确认驳回", exact: true })).toBeDisabled();
  await reject.getByRole("radio").first().check();
  await expect(reject.getByRole("button", { name: "确认驳回", exact: true })).toBeDisabled();
  await reject
    .getByRole("textbox", { name: "驳回说明", exact: true })
    .fill("演练：请补充完整银行回单以核对到账信息");
  await shot(page, "receipts-03-reject");
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/transfer-proofs\/[^/]+\/reject$/.test(new URL(response.url()).pathname),
  );
  await reject.getByRole("button", { name: "确认驳回", exact: true }).click();
  expect((await rejected).status()).toBe(200);
  await expect(queue.locator("[data-queue-item]")).toHaveCount(1);
  await page.getByRole("tab", { name: /今日已处理/ }).click();
  await expect(queue.locator("[data-queue-item]")).toHaveCount(2);
  await expect(page.getByTestId("queue-result")).toBeVisible();
  await shot(page, "receipts-04-today");
  expect(errors).toEqual([]);
});
