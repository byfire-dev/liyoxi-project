import {
  PaymentExceptionDetailSchema,
  PaymentExceptionPageSchema,
  PaymentExceptionResolveBodySchema,
  PaymentExceptionResolveResultSchema,
  PaymentOrderAdminDetailSchema,
  ReconMonthSchema,
} from "@liyoxi/contract";
import { expect, test } from "@playwright/test";
import { moneyText } from "../../src/features/finance/payments/model";
import { liveContext, recordErrors } from "./live-context";
import { readFinance, reconcileFixture, reconcileShot } from "./finance-reconcile-live-support";
import { ensureLiveStepUp } from "./live-step-up";

test("对账差异：真实登记未关联收款、候选关联入账、同意图重放及精确GET", async ({ page }) => {
  const f = reconcileFixture(),
    errors = recordErrors(page),
    month = new Date(new Date(f.receivedAt).getTime() + 8 * 3600_000).toISOString().slice(0, 7),
    before = PaymentOrderAdminDetailSchema.parse(
      await readFinance(page, `/payment-orders/${f.paymentOrderId}`),
    );
  expect(before.status).toBe("pending_payment");
  expect(before.paymentTxns).toHaveLength(0);
  const params = new URLSearchParams({ month, tab: "all", q: f.bankSerialNo });
  await page.goto(`/finance/reconcile?${params}`);
  await expect(page.getByRole("heading", { name: "对账与差异", exact: true })).toBeVisible();
  const monthly = ReconMonthSchema.parse(
    await readFinance(page, `/reconciliations?month=${month}`),
  );
  expect(monthly.month).toBe(month);
  await reconcileShot(page, "month", false);
  await ensureLiveStepUp(page);
  await page.getByRole("button", { name: "登记未关联收款", exact: true }).click();
  const create = page.getByRole("dialog", { name: "登记未关联对公收款" });
  await create
    .getByLabel("到账时间（北京时间）")
    .fill(new Date(new Date(f.receivedAt).getTime() + 8 * 3600_000).toISOString().slice(0, 16));
  await create.getByLabel("到账金额（分）").fill(String(f.amountFen));
  await create.getByLabel("原付款人名称").fill(f.payerName);
  await create.getByLabel("银行流水号", { exact: true }).fill(f.bankSerialNo);
  await create.getByLabel("登记说明").fill(f.note);
  await create.getByRole("checkbox").check();
  const createdResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/admin/payment-exceptions",
  );
  await create.getByRole("button", { name: "登记差异", exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(200);
  const created = PaymentExceptionDetailSchema.parse((await response.json()).data);
  expect(created).toMatchObject({
    kind: "bank_unmatched",
    status: "open",
    entity: null,
    amountFen: f.amountFen,
  });
  expect(created.paymentTxn?.isApplied).toBe(false);
  expect(created.linkCandidates.some((row) => row.paymentOrderId === f.paymentOrderId)).toBe(true);
  const open = PaymentExceptionPageSchema.parse(
    await readFinance(page, `/payment-exceptions?tab=open&q=${f.bankSerialNo}&page=1&pageSize=10`),
  );
  expect(open.items.map((row) => row.paymentExceptionId)).toContain(created.paymentExceptionId);
  await expect(create).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`paymentExceptionId=${created.paymentExceptionId}`));
  const detail = page.getByRole("complementary", { name: "差异详情与处理" });
  await expect(detail.getByText(created.exceptionNo, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "处理差异", exact: true }).click();
  const resolve = page.getByRole("dialog", { name: `处理差异 ${created.exceptionNo}` });
  await resolve.getByRole("combobox", { name: "差异处理方式" }).click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("关联付款单并入账", { exact: true })
    .click();
  await resolve.getByRole("combobox", { name: "可关联付款单" }).click();
  await page.locator(".ant-select-item-option-content").filter({ hasText: f.orderNo }).click();
  const resolutionNote = "已核对虚构银行流水并关联本轮候选付款单";
  await resolve.getByLabel("处理说明").fill(resolutionNote);
  await resolve.getByRole("checkbox").check();
  const resolvedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname ===
        `/api/v1/admin/payment-exceptions/${created.paymentExceptionId}/resolve`,
  );
  await resolve.getByRole("button", { name: "确认关联付款单并入账", exact: true }).click();
  const changedResponse = await resolvedResponse;
  expect(changedResponse.status()).toBe(200);
  const changed = PaymentExceptionResolveResultSchema.parse((await changedResponse.json()).data);
  expect(changed.outcome).toBe("resolved");
  await expect(resolve).not.toBeVisible();
  await expect(detail.getByText("已处理", { exact: true })).toBeVisible();
  const fresh = PaymentExceptionDetailSchema.parse(
    await readFinance(page, `/payment-exceptions/${created.paymentExceptionId}`),
  );
  expect(fresh).toMatchObject({
    status: "resolved",
    resolution: "link_order",
    paymentOrder: { paymentOrderId: f.paymentOrderId },
    paymentTxn: { isApplied: true },
  });
  expect(fresh.lockVersion).toBeGreaterThan(created.lockVersion);
  const order = PaymentOrderAdminDetailSchema.parse(
    await readFinance(page, `/payment-orders/${f.paymentOrderId}`),
  );
  expect(order.status).toBe("paid");
  expect(order.paymentTxns).toHaveLength(1);
  const request = changedResponse.request(),
    replay = await page.request.post(request.url(), {
      headers: {
        Origin: liveContext().origin,
        "X-LYX-Admin": "1",
        "Idempotency-Key": request.headers()["idempotency-key"]!,
      },
      // 浏览器fetch流可能不保留postData；沿同次真实确认值重建，服务端原key哈希继续核验同正文。
      data: PaymentExceptionResolveBodySchema.parse({
        lockVersion: created.lockVersion,
        resolution: "link_order",
        note: resolutionNote,
        linkPaymentOrderId: f.paymentOrderId,
        confirm: { exceptionNo: created.exceptionNo, amountFen: created.amountFen },
      }),
    });
  expect(replay.status()).toBe(200);
  expect(PaymentExceptionResolveResultSchema.parse((await replay.json()).data)).toEqual(changed);
  const afterReplay = PaymentOrderAdminDetailSchema.parse(
    await readFinance(page, `/payment-orders/${f.paymentOrderId}`),
  );
  expect(afterReplay.paymentTxns).toEqual(order.paymentTxns);
  const listed = PaymentExceptionPageSchema.parse(
    await readFinance(
      page,
      `/payment-exceptions?tab=all&q=${encodeURIComponent(created.exceptionNo)}&page=1&pageSize=10`,
    ),
  );
  expect(
    listed.items.some(
      (row) => row.paymentExceptionId === fresh.paymentExceptionId && row.status === "resolved",
    ),
  ).toBe(true);
  await page.reload();
  await expect(detail.getByText("已处理", { exact: true })).toBeVisible();
  await expect(detail.getByText(moneyText(f.amountFen), { exact: true }).first()).toBeVisible();
  await reconcileShot(page, "linked");
  expect(errors).toEqual([]);
});
