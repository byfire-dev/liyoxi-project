import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  PaymentTransactionPageSchema,
  PaymentTransactionSummarySchema,
  RefundRequestDetailSchema,
} from "@liyoxi/contract";
import { moneyText } from "../../src/features/finance/payments/model";
import { liveContext, noHorizontalScroll } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";

interface Fixture {
  prefix: string;
  items: {
    paymentOrderId: string;
    orderNo: string;
    entityName: string;
    amountFen: number;
    channelSuccessAt: string;
  }[];
  refund: {
    requesterStaffId: string;
    approvalId: string;
    selfApprovalRejectedWithoutLedgerWrites: boolean;
    refundRequestId: string;
    requestNo: string;
    amountFen: number;
    entityId: string;
    entityName: string;
  };
}
const fixture = () => (liveContext().fixtures as { fixtures: { w418: Fixture } }).fixtures.w418;
async function read(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/admin${path}`);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as unknown;
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync("dist/e2e-shots", { recursive: true });
  try {
    // 不用截图掩盖真实重复渲染；先断言新视口只有一套实际DOM并已重新布局。
    const geometry = () =>
      page.evaluate(() => {
        const shell = document.querySelector(".lyx-shell")?.getBoundingClientRect();
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          shells: document.querySelectorAll(".lyx-shell").length,
          siders: document.querySelectorAll(".lyx-shell__sider").length,
          headers: document.querySelectorAll(".lyx-shell__header").length,
          top: shell?.top,
          shellHeight: shell?.height,
        };
      });
    await expect.poll(geometry).toEqual({
      width: 1440,
      height: 900,
      shells: 1,
      siders: 1,
      headers: 1,
      top: 0,
      shellHeight: 900,
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    const observed = await geometry();
    expect(observed).toEqual({
      width: 1440,
      height: 900,
      shells: 1,
      siders: 1,
      headers: 1,
      top: 0,
      shellHeight: 900,
    });
    writeFileSync(`dist/e2e-shots/w418-${name}.geometry.json`, `${JSON.stringify(observed)}\n`);
    await page.screenshot({ path: `dist/e2e-shots/w418-${name}.png`, animations: "disabled" });
  } finally {
    await page.setViewportSize({ width: 1366, height: 768 });
  }
}
function errors(page: Page, expected500?: string) {
  const unexpected: string[] = [];
  const allowed: string[] = [];
  page.on("pageerror", (error) => unexpected.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    if (expected500 && url.endsWith(expected500) && /\b500\b/.test(message.text()))
      allowed.push(url);
    else unexpected.push(message.text());
  });
  return { unexpected, allowed };
}

test("收款只读首片：真实成功日和渠道筛选、URL重载、同筛选合计与空结果", async ({ page }) => {
  const f = fixture(),
    recorded = errors(page);
  expect(f.items).toHaveLength(2);
  const successDate = new Date(new Date(f.items[0]!.channelSuccessAt).getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const params = new URLSearchParams({
    q: f.prefix,
    channel: "bank_transfer",
    successFrom: successDate,
    successTo: successDate,
    pageSize: "10",
  });
  const path = `/payment-transactions?${params}`;
  const actual = PaymentTransactionPageSchema.parse(await read(page, path));
  expect(actual.total).toBe(2);
  expect(actual.items.map((r) => r.paymentOrder?.orderNo).sort()).toEqual(
    f.items.map((r) => r.orderNo).sort(),
  );
  const summaryParams = new URLSearchParams(params);
  summaryParams.delete("pageSize");
  const summary = PaymentTransactionSummarySchema.parse(
    await read(page, `/payment-transactions/summary?${summaryParams}`),
  );
  const expectedAmount = f.items.reduce((sum, r) => sum + BigInt(r.amountFen), 0n).toString();
  expect(summary.filtered).toEqual({ count: 2, channelAmountFen: expectedAmount });
  await page.goto(`/finance/payments?${params}`);
  await expect(page.getByRole("heading", { name: "收款流水", exact: true })).toBeVisible();
  for (const item of f.items)
    await expect(page.getByRole("row").filter({ hasText: item.orderNo })).toContainText(
      item.entityName,
    );
  await expect(
    page.getByText(`2 笔 · ${moneyText(expectedAmount)}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("收款开始日期", { exact: true })).toHaveValue(successDate);
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: f.items[0]!.orderNo })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("channel")).toBe("bank_transfer");
  await shot(page, "payments");
  const keyword = page.getByPlaceholder("搜索付款单号、交易单号、商家");
  await keyword.fill(`${f.prefix}无此收款`);
  await keyword.press("Enter");
  await expect(page.getByText("没有符合条件的收款流水", { exact: true })).toBeVisible();
  await expect(page.getByText("0 笔 · ¥0.00", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe(`${f.prefix}无此收款`);
  expect(recorded.unexpected).toEqual([]);
});

test("退款只读首片：真实待批详情、读取失败后真实重试及切筛选清除选中", async ({ page }) => {
  const f = fixture(),
    detailPath = `/api/v1/admin/refund-requests/${f.refund.refundRequestId}`;
  const recorded = errors(page, detailPath);
  const actual = RefundRequestDetailSchema.parse(
    await read(page, `/refund-requests/${f.refund.refundRequestId}`),
  );
  expect(actual).toMatchObject({
    refundRequestId: f.refund.refundRequestId,
    status: "pending_approval",
    amountFen: f.refund.amountFen,
    entity: { entityId: f.refund.entityId },
  });
  await page.goto(`/finance/refunds?q=${encodeURIComponent(f.prefix)}`);
  await expect(page.getByRole("heading", { name: "退款管理", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: f.refund.requestNo })).toBeVisible();
  const detailPanel = page.getByRole("complementary", { name: "退款详情", exact: true });
  await expect(detailPanel.getByText("请选择一条记录", { exact: true })).toBeVisible();
  await shot(page, "refunds-list");
  // 仅注入一次受控失败，不制造成功；移除后由同一真实端点完成详情重试。
  await page.route(`**${detailPath}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        code: 50001,
        error: "INTERNAL",
        message: "只读验收受控故障",
        retryable: false,
      }),
    });
  });
  await page
    .getByRole("row")
    .filter({ hasText: f.refund.requestNo })
    .getByRole("button", { name: "查看", exact: true })
    .click();
  await expect(detailPanel.getByText("数据暂未能读取，请重试", { exact: true })).toBeVisible();
  await page.unroute(`**${detailPath}`);
  await detailPanel.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(detailPanel.getByText(f.refund.requestNo, { exact: true })).toBeVisible();
  await expect(
    detailPanel.getByText("渠道结果与入账事实仅供查看；处理动作按当前服务端授权显示。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(actual.actions).toEqual(expect.arrayContaining(["approve", "reject"]));
  await expect(detailPanel.getByRole("button", { name: "通过审批", exact: true })).toBeVisible();
  await expect(detailPanel.getByRole("button", { name: "撤回", exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("refundRequestId")).toBe(f.refund.refundRequestId);
  const notice = page.locator(".ant-notification-notice").filter({ hasText: "只读验收受控故障" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await shot(page, "refund-detail");
  const keyword = page.getByPlaceholder("搜索退款单号、付款单号、商家");
  await keyword.fill(`${f.prefix}无此退款`);
  await keyword.press("Enter");
  await expect(page.getByText("没有符合条件的现金退款申请", { exact: true })).toBeVisible();
  await expect(detailPanel.getByText("请选择一条记录", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("refundRequestId")).toBeNull();
  expect(recorded.allowed).toHaveLength(1);
  expect(recorded.unexpected).toEqual([]);
});

test("退款审批决定：自审拒绝、异人业务深链、实际通过及作废均重新GET核验", async ({ page }) => {
  const f = fixture().refund,
    recorded = errors(page),
    panel = page.getByRole("complementary", { name: "退款详情", exact: true });
  expect(f.selfApprovalRejectedWithoutLedgerWrites).toBe(true);
  const me = (await read(page, "/auth/me")) as { staff: { staffId: string } };
  expect(me.staff.staffId).not.toBe(f.requesterStaffId);
  const before = RefundRequestDetailSchema.parse(
    await read(page, `/refund-requests/${f.refundRequestId}`),
  );
  expect(before).toMatchObject({
    status: "pending_approval",
    requester: { staffId: f.requesterStaffId },
    approval: { approvalId: f.approvalId, kind: "plan_refund", status: "pending" },
    refundTxns: [],
    entitlementRevokedAt: null,
  });
  await ensureLiveStepUp(page);
  await page.goto(`/approvals?tab=all&kind=plan_refund&id=${f.approvalId}`);
  const approval = page.getByRole("dialog", { name: "审批详情", exact: true });
  await approval.getByRole("link", { name: "进入业务处理", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/finance/refunds\\?refundRequestId=${f.refundRequestId}$`),
  );
  await expect(panel.getByText(f.requestNo, { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "通过审批", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "通过审批退款申请", exact: true });
  await expect(confirm.getByText(f.requestNo, { exact: true })).toBeVisible();
  await expect(confirm.getByText(moneyText(f.amountFen), { exact: true })).toBeVisible();
  await expect(confirm.getByRole("button", { name: "确认通过审批", exact: true })).toBeDisabled();
  await confirm
    .getByRole("checkbox", { name: "我已核对退款规则、核算依据与金额", exact: true })
    .check();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/refund-requests/${f.refundRequestId}/approve`),
  );
  await confirm.getByRole("button", { name: "确认通过审批", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(confirm).toBeHidden();
  await expect(panel.getByRole("button", { name: "通过审批", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "作废", exact: true })).toBeVisible();
  const approved = RefundRequestDetailSchema.parse(
    await read(page, `/refund-requests/${f.refundRequestId}`),
  );
  expect(approved).toMatchObject({
    status: "pending_execution",
    amountFen: f.amountFen,
    approval: { status: "approved", decidedBy: { staffId: me.staff.staffId } },
    refundTxns: [],
    entitlementRevokedAt: null,
    doneAt: null,
  });
  expect(approved.approval.lockVersion).toBeGreaterThan(before.approval.lockVersion);
  await page.getByRole("heading", { name: "退款管理", exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "refund-approved");
  await panel.getByRole("button", { name: "作废", exact: true }).click();
  const voidDialog = page.getByRole("dialog", { name: "作废退款申请", exact: true });
  await voidDialog.getByRole("textbox").fill("异人核对后取消待执行申请");
  await voidDialog
    .getByRole("checkbox", { name: "我已核对申请、金额与处理说明", exact: true })
    .check();
  const voidedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/refund-requests/${f.refundRequestId}/void`),
  );
  await voidDialog.getByRole("button", { name: "确认作废", exact: true }).click();
  expect((await voidedResponse).status()).toBe(200);
  await expect(voidDialog).toBeHidden();
  await expect(panel.getByRole("button", { name: "作废", exact: true })).toHaveCount(0);
  const voided = RefundRequestDetailSchema.parse(
    await read(page, `/refund-requests/${f.refundRequestId}`),
  );
  expect(voided).toMatchObject({
    status: "not_executed",
    closeReason: "voided",
    closeNote: "异人核对后取消待执行申请",
    voidedBy: { staffId: me.staff.staffId },
    refundTxns: [],
    entitlementRevokedAt: null,
    doneAt: null,
  });
  await page.getByRole("heading", { name: "退款管理", exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "refund-voided");
  expect(recorded.unexpected).toEqual([]);
});
