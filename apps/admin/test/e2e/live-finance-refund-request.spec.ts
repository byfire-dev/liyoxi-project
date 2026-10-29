import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  ApprovalDetailSchema,
  CashRefundQuoteSchema,
  DictItemListSchema,
  PaymentOrderAdminDetailSchema,
  RefundRequestDetailSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";
interface PaidItem {
  paymentOrderId: string;
  orderNo: string;
  entityId: string;
  paymentTransactionId: string;
  amountFen: number;
}
async function read(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/admin${path}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as unknown;
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector(".lyx-shell")?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      shells: document.querySelectorAll(".lyx-shell").length,
      siders: document.querySelectorAll(".lyx-shell__sider").length,
      headers: document.querySelectorAll(".lyx-shell__header").length,
      top: shell?.top,
      shellHeight: shell?.height,
    };
  });
  expect(geometry).toEqual({
    width: 1440,
    height: 900,
    shells: 1,
    siders: 1,
    headers: 1,
    top: 0,
    shellHeight: 900,
  });
  mkdirSync("dist/e2e-shots", { recursive: true });
  writeFileSync(
    `dist/e2e-shots/w418-refund-request-${name}.geometry.json`,
    `${JSON.stringify(geometry)}\n`,
  );
  await page.screenshot({
    path: `dist/e2e-shots/w418-refund-request-${name}.png`,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1366, height: 768 });
}
test("现金退款发起：复用真实收款、关联差异导航、实际quote/create与GET退款投影，未审批不退款", async ({
  page,
}) => {
  const f = (liveContext().fixtures as { fixtures: { w418: { items: PaidItem[] } } }).fixtures.w418
    .items[1]!;
  const errors = recordErrors(page),
    writes: { key: string | null }[] = [];
  const order = PaymentOrderAdminDetailSchema.parse(
    await read(page, `/payment-orders/${f.paymentOrderId}`),
  );
  expect(order).toMatchObject({
    orderNo: f.orderNo,
    status: "paid",
    paidAmountFen: f.amountFen,
    refundRequests: [],
  });
  const me = await page.request.get("/api/v1/admin/auth/me");
  expect(me.status()).toBe(200);
  const staffId = (await me.json()).data.staff.staffId as string;
  await ensureLiveStepUp(page);
  const quoted = await page.request.post(
    `/api/v1/admin/payment-orders/${f.paymentOrderId}/refund-quote`,
    { data: { ruleCode: "window" }, headers: { Origin: liveContext().origin, "X-LYX-Admin": "1" } },
  );
  expect(quoted.status()).toBe(200);
  const quote = CashRefundQuoteSchema.parse((await quoted.json()).data);
  expect(quote).toMatchObject({
    supported: true,
    openRequest: null,
    refundableFen: f.amountFen,
    paymentTxn: { paymentTransactionId: f.paymentTransactionId },
  });
  expect(quote.rules).toContainEqual({ rule: "window", eligible: true, reasons: [] });
  const dictionary = DictItemListSchema.parse(
      await read(page, "/dict-items?typeKey=refund_reason"),
    ),
    reason = dictionary.items.find((row) => row.code === "RF418");
  expect(reason?.isEnabled).toBe(true);
  await page.goto(`/finance/payments?q=${encodeURIComponent(f.orderNo)}`);
  const row = page.getByRole("row").filter({ hasText: f.orderNo });
  await expect(row).toHaveCount(1);
  await row.getByRole("link", { name: "查看关联差异", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/finance/reconcile\\?.*q=${encodeURIComponent(f.orderNo)}`),
  );
  await expect(page.getByRole("heading", { name: "对账与差异", exact: true })).toBeVisible();
  await page.goto(`/finance/payments?q=${encodeURIComponent(f.orderNo)}`);
  await row.getByRole("button", { name: "申请现金退款", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "申请现金退款", exact: true });
  await expect(dialog.getByRole("combobox", { name: "退款规则", exact: true })).toHaveValue("");
  await expect(dialog.getByText("七天未使用窗口", { exact: true }).first()).toBeVisible();
  await dialog.getByRole("combobox", { name: "退款原因", exact: true }).click();
  await page.getByText(reason!.name, { exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "申请说明", exact: true })
    .fill("本轮虚构现金退款申请，须另人审批执行");
  await dialog
    .getByRole("checkbox", { name: "我已核对退款规则、金额、周期与权益影响", exact: true })
    .check();
  await dialog.getByLabel("请输入付款单号后4位", { exact: true }).fill(f.orderNo.slice(-4));
  const submit = dialog.getByRole("button", { name: "确认申请现金退款", exact: true });
  await expect(submit).toBeEnabled();
  await submit.scrollIntoViewIfNeeded();
  await shot(page, "confirm");
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/api/v1/admin/payment-orders/${f.paymentOrderId}/refund-requests`
    )
      writes.push({
        key: request.headers()["idempotency-key"] ?? null,
      });
  });
  const written = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/admin/payment-orders/${f.paymentOrderId}/refund-requests`,
  );
  await submit.click();
  const response = await written;
  expect(response.status()).toBe(200);
  const submitted = RefundRequestDetailSchema.parse((await response.json()).data);
  await expect(
    dialog.getByText(`已读取退款申请 ${submitted.requestNo}`, { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.key).toBeTruthy();
  const current = RefundRequestDetailSchema.parse(
    await read(page, `/refund-requests/${submitted.refundRequestId}`),
  );
  expect({
    ruleCode: current.ruleCode,
    reasonCode: current.reason?.code,
    note: current.note,
    confirm: { orderNo: current.paymentOrder?.orderNo, amountFen: current.amountFen },
  }).toEqual({
    ruleCode: "window",
    reasonCode: "RF418",
    note: "本轮虚构现金退款申请，须另人审批执行",
    confirm: { orderNo: f.orderNo, amountFen: quote.refundableFen },
  });
  expect(current).toMatchObject({
    refundRequestId: submitted.refundRequestId,
    requestNo: submitted.requestNo,
    status: "pending_approval",
    amountFen: quote.refundableFen,
    paymentOrder: { paymentOrderId: f.paymentOrderId },
    paymentTxn: { paymentTransactionId: f.paymentTransactionId },
    approval: { status: "pending", requester: { staffId } },
    refundTxns: [],
    entitlementRevokedAt: null,
  });
  const after = PaymentOrderAdminDetailSchema.parse(
    await read(page, `/payment-orders/${f.paymentOrderId}`),
  );
  expect(after.refundRequests).toEqual([
    {
      refundRequestId: current.refundRequestId,
      requestNo: current.requestNo,
      ruleCode: "window",
      amountFen: current.amountFen,
      status: "pending_approval",
      closeReason: null,
      createdAt: current.createdAt,
    },
  ]);
  expect(after.refundedAmountFen).toBe(0);
  expect(
    after.paymentTxns.find((txn) => txn.paymentTransactionId === f.paymentTransactionId)
      ?.refundedFen,
  ).toBe(0);
  await shot(page, "created");
  await dialog.getByRole("link", { name: "查看退款申请与后续处理", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "退款详情", exact: true })
      .getByText(current.requestNo, { exact: true }),
  ).toBeVisible();
  const approval = ApprovalDetailSchema.parse(
    await read(page, `/approvals/${current.approval.approvalId}`),
  );
  expect(approval).toMatchObject({
    approvalId: current.approval.approvalId,
    kind: "plan_refund",
    status: "pending",
    domain: { type: "refund_request", id: current.refundRequestId },
  });
  await page.goto(`/approvals?tab=all&kind=plan_refund&id=${approval.approvalId}`);
  const approvalPanel = page.getByRole("dialog", { name: "审批详情", exact: true });
  await expect(
    approvalPanel.getByRole("heading", { name: approval.summary.title, exact: true }),
  ).toBeVisible();
  await expect(approvalPanel.getByText("现金退款 / 待处理", { exact: true })).toBeVisible();
  await expect(approvalPanel.getByRole("link", { name: /业务/ })).toHaveAttribute(
    "href",
    `/finance/refunds?refundRequestId=${current.refundRequestId}`,
  );
  await shot(page, "approval");
  expect(errors).toEqual([]);
});
