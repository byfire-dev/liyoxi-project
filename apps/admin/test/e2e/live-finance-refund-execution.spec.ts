import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { RefundRequestDetailSchema } from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";
interface Fixture {
  refundRequestId: string;
  requestNo: string;
  amountFen: number;
  entityId: string;
  entityName: string;
  requesterStaffId: string;
  approverStaffId: string;
  transferDate: string;
  bankSerialNo: string;
  pdf: string;
}
async function shot(page: Page, name: string) {
  if ((await page.getByRole("dialog").count()) === 0)
    await page.getByRole("heading", { name: "退款管理", exact: true }).scrollIntoViewIfNeeded();
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
    `dist/e2e-shots/w418-refund-${name}.geometry.json`,
    `${JSON.stringify(geometry)}\n`,
  );
  await page.screenshot({ path: `dist/e2e-shots/w418-refund-${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
test("线下退款：异人批准后按实际转账/回单登记，真实GET核退款流水与脱敏账户", async ({ page }) => {
  const f = (liveContext().fixtures as { fixtures: { w418: { execution: Fixture } } }).fixtures.w418
      .execution,
    errors = recordErrors(page),
    detail = page.getByRole("complementary", { name: "退款详情", exact: true });
  const read = async () => {
    const response = await page.request.get(`/api/v1/admin/refund-requests/${f.refundRequestId}`);
    expect(response.status()).toBe(200);
    return RefundRequestDetailSchema.parse((await response.json()).data);
  };
  const meResponse = await page.request.get("/api/v1/admin/auth/me");
  expect(meResponse.status()).toBe(200);
  const me = (await meResponse.json()).data as { staff: { staffId: string } };
  expect(me.staff.staffId).toBe(f.requesterStaffId);
  expect(me.staff.staffId).not.toBe(f.approverStaffId);
  const before = await read();
  expect(before.status).toBe("pending_execution");
  expect(before.refundTxns).toHaveLength(0);
  expect(before.approval.decidedBy?.staffId).toBe(f.approverStaffId);
  await ensureLiveStepUp(page);
  await page.goto(`/finance/refunds?tab=pending_execution&refundRequestId=${f.refundRequestId}`);
  await expect(detail.getByText(f.requestNo, { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "执行微信退款", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "登记线下退款", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登记线下退款", exact: true });
  await expect(
    dialog.getByRole("button", { name: "确认登记线下退款", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("转账日期", { exact: true }).fill(f.transferDate);
  await dialog.getByRole("textbox", { name: "银行流水号", exact: true }).fill(f.bankSerialNo);
  await expect(dialog.getByRole("textbox", { name: "收款户名", exact: true })).toHaveValue(
    f.entityName,
  );
  await expect(dialog.getByRole("textbox", { name: "收款户名", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "收款银行", exact: true }).fill("本轮虚构银行");
  await dialog.getByLabel("收款账号", { exact: true }).fill("000000001234");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "fictional-refund.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(f.pdf, "base64"),
  });
  await expect(dialog.getByRole("button", { name: "重新上传（替换）", exact: true })).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "我已核对实际线下转账、金额、收款账户与回单", exact: true })
    .check();
  await dialog.getByLabel("请输入退款单号后4位", { exact: true }).fill(f.requestNo.slice(-4));
  await shot(page, "offline-confirm");
  const written = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/refund-requests/${f.refundRequestId}/record-offline`),
  );
  await dialog.getByRole("button", { name: "确认登记线下退款", exact: true }).click();
  expect((await written).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  const current = await read();
  expect(current).toMatchObject({
    status: "done",
    execRoute: "offline",
    amountFen: f.amountFen,
    executedBy: { staffId: me.staff.staffId },
  });
  expect(current.doneAt).not.toBeNull();
  expect(current.entitlementRevokedAt).not.toBeNull();
  expect(current.refundTxns).toHaveLength(1);
  expect(current.refundTxns[0]).toMatchObject({
    channel: "offline",
    status: "succeeded",
    amountFen: f.amountFen,
    channelRefundNo: f.bankSerialNo,
    offline: {
      transferDate: f.transferDate,
      payeeName: f.entityName,
      payeeBank: "本轮虚构银行",
      payeeAccountMask: "****1234",
      registeredBy: { staffId: me.staff.staffId },
    },
  });
  expect(current.paymentTxn.refundedFen).toBe(f.amountFen);
  await expect(detail.getByText(f.bankSerialNo, { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "查看退款回单", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "登记线下退款", exact: true })).toHaveCount(0);
  await noHorizontalScroll(page, "实际线下退款完成");
  await shot(page, "offline-done");
  expect(errors).toEqual([]);
});
