import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  PointAccountDetailSchema,
  PlanAdminColumnSchema,
  PaymentOrderAdminDetailSchema,
  TransferProofDetailSchema,
  BillingParamListSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { ensureLiveStepUp, writeWithLiveStepUp } from "./live-step-up";
interface Fixture {
  prefix: string;
  entityId: string;
  entityName: string;
  storeId: string;
  spendablePoints: number;
  planId: string;
  planName: string;
  planCode: string;
  pack: { id: string; points: number; priceFen: number };
  initialPaymentOrderId: string;
  receipt: { name: string; mime: string; base64: string };
}
const fixture = () => (liveContext().fixtures as { fixtures: { w417: Fixture } }).fixtures.w417;
async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1/admin${path}`);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as T;
}
async function write(page: Page, path: string, body: unknown, key: string) {
  return writeWithLiveStepUp(page, () =>
    page.request.post(`/api/v1/admin${path}`, {
      headers: { Origin: liveContext().origin, "X-LYX-Admin": "1", "Idempotency-Key": key },
      data: body,
    }),
  );
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: `dist/e2e-shots/w417-${name}.png`, animations: "disabled" });
}
async function option(page: Page, name: string) {
  await page.locator(".ant-select-dropdown:visible").getByTitle(name, { exact: true }).click();
}

test("套餐真实首价/上架/只读试算与所见版本冲突守卫", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page),
    consoleErrors: { text: string; url: string }[] = [];
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  await ensureLiveStepUp(page);
  await page.goto(`/billing/plans?planId=${f.planId}`);
  const row = page.getByRole("row").filter({ hasText: f.planCode });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "发布修订", exact: true }).click();
  const revision = page.getByRole("dialog", { name: `发布价目修订 · ${f.planName}`, exact: true });
  await revision.getByLabel("月费（元）", { exact: true }).fill("500000");
  await revision.getByRole("spinbutton", { name: "每月积分", exact: true }).fill("1000000");
  await revision.getByRole("checkbox", { name: "已核对价格、权益与生效时间" }).check();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/plans/${f.planId}/plan-revisions`),
  );
  await revision.getByRole("button", { name: "保存价目与公告", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(revision).toBeHidden();
  await row.getByRole("button", { name: "上架", exact: true }).click();
  const shelve = page.getByRole("dialog", { name: "上架套餐", exact: true });
  await shelve.getByRole("checkbox").check();
  await shelve.getByRole("button", { name: "确认", exact: true }).click();
  await expect(shelve).toBeHidden();
  const panel = page.getByRole("region", { name: "通用报价试算" });
  await panel.getByLabel("试算类型").click();
  await option(page, "续费");
  await panel.getByLabel("目标套餐").click();
  await option(page, f.planName);
  await panel.getByRole("button", { name: "试算", exact: true }).click();
  await expect(panel.getByRole("status")).not.toBeEmpty();
  await shot(page, "plans-quote");
  await row.getByRole("button", { name: "改名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "修改套餐名称", exact: true });
  await rename.getByLabel("套餐名称").fill(`${f.prefix}保留草稿`);
  const plans = await read<{ items: unknown[] }>(page, "/plans"),
    seen = plans.items
      .map((v) => PlanAdminColumnSchema.parse(v))
      .find((p) => p.planId === f.planId)!;
  const changed = await writeWithLiveStepUp(page, () =>
    page.request.patch(`/api/v1/admin/plans/${f.planId}`, {
      headers: {
        Origin: liveContext().origin,
        "X-LYX-Admin": "1",
        "Idempotency-Key": `w417-other:${crypto.randomUUID()}`,
      },
      data: { lockVersion: seen.lockVersion, name: `${f.prefix}另一修改` },
    }),
  );
  expect(changed.status()).toBe(200);
  const staleResponse = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(`/plans/${f.planId}`),
  );
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  const stale = await staleResponse;
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "VERSION_CONFLICT" });
  await expect(
    rename.getByText(
      "当前事实已经变化，草稿仍保留。请关闭后重新读取并核对，不能用新版本自动覆盖。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(rename.getByLabel("套餐名称")).toHaveValue(`${f.prefix}保留草稿`);
  await expect(rename.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await shot(page, "plans-conflict");
  const expectedResourceError =
    "Failed to load resource: the server responded with a status of 409 (Conflict)";
  expect(consoleErrors).toEqual([{ text: expectedResourceError, url: stale.url() }]);
  expect(errors).toEqual([expectedResourceError]);
});

test("积分包真实创建/编辑版本与上下架动作", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await ensureLiveStepUp(page);
  await page.goto("/billing/point-packs");
  await page.getByRole("button", { name: "新增积分包", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增积分包（保存后上架）", exact: true });
  await dialog.getByRole("spinbutton", { name: "积分数量（至少100）", exact: true }).fill("7777");
  await dialog.getByLabel("售价（元）", { exact: true }).fill("77.70");
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/admin/point-packs",
  );
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const pack = (await response.json()).data as { pointPackId: string };
  await expect(dialog).toBeHidden();
  const row = page.locator(`tr[data-row-key="${pack.pointPackId}"]`);
  await expect(row).toContainText("7,777");
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑积分包", exact: true });
  await edit.getByLabel("售价（元）", { exact: true }).fill("78.80");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("78.80");
  await shot(page, "point-packs");
  await row.getByRole("button", { name: "下架", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "下架积分包", exact: true });
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(row).toContainText("已下架");
  expect(f.entityId).toBeTruthy();
  expect(errors).toEqual([]);
});

test("参数真实待生效变更/前后对照/撤回，不改变当前规则", async ({ page }) => {
  const errors = recordErrors(page);
  await ensureLiveStepUp(page);
  const original = BillingParamListSchema.parse(await read(page, "/billing-params")),
    current = original.items.find((p) => p.key === "adUnitPoints")!;
  expect(typeof current.current.value).toBe("number");
  await page.goto("/billing/params");
  await page.getByRole("button", { name: "新建变更集", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "保存积分价模板与参数变更", exact: true });
  await dialog.getByRole("combobox", { name: "本次修改的计费参数", exact: true }).click();
  await option(page, "每条广告积分");
  await dialog.getByRole("combobox", { name: "本次修改的计费参数", exact: true }).press("Escape");
  await dialog
    .getByRole("spinbutton", { name: "每条广告积分", exact: true })
    .fill(String(Number(current.current.value) + 1));
  await dialog
    .getByLabel("参数生效日", { exact: true })
    .fill(original.earliestNoticedEffectiveDate);
  await dialog.getByLabel("参数生效日", { exact: true }).press("Enter");
  await dialog.getByRole("checkbox", { name: "已核对所选变更、前后值与生效日期" }).check();
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/pricing-changes"),
  );
  await dialog.getByRole("button", { name: "保存变更集", exact: true }).click();
  expect((await created).status()).toBe(200);
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: "每条广告积分" });
  await expect(row.getByRole("button", { name: "撤回", exact: true })).toBeVisible();
  await shot(page, "params-pending");
  const before = BillingParamListSchema.parse(await read(page, "/billing-params")).items.find(
    (p) => p.key === "adUnitPoints",
  )!;
  expect(before.current.value).toEqual(current.current.value);
  expect(before.pending?.value).toBe(Number(current.current.value) + 1);
  await row.getByRole("button", { name: "撤回", exact: true }).click();
  const withdraw = page.getByRole("dialog", { name: "撤回待生效参数", exact: true });
  await withdraw.getByRole("checkbox").check();
  await withdraw.getByRole("button", { name: "确认", exact: true }).click();
  await expect(withdraw).toBeHidden();
  await expect(row.getByRole("button", { name: "撤回", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "变更记录", exact: true }).click();
  await expect(page.getByText("暂无变更记录", { exact: true })).toHaveCount(0);
  await shot(page, "params-history");
  expect(errors).toEqual([]);
});

test("账户真实流水/调整申请不入账，撤回本人申请；到期筛选真实空态", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await ensureLiveStepUp(page);
  await page.goto(
    `/billing/accounts?accountId=${f.entityId}&q=${encodeURIComponent(f.entityName)}`,
  );
  await expect(page.getByRole("heading", { name: f.entityName, exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "账户流水", exact: true }).locator("tr[data-row-key]"),
  ).not.toHaveCount(0);
  await shot(page, "accounts-ledger");
  await page.getByRole("button", { name: "发起积分调整", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `发起积分调整 · ${f.entityName}`, exact: true });
  await dialog.getByRole("spinbutton", { name: "调整积分", exact: true }).fill("7");
  await dialog.getByLabel("调整原因", { exact: true }).click();
  await option(page, "服务补偿");
  await dialog.getByLabel("调整依据（5–200字）", { exact: true }).fill("W417演练的虚构补偿依据");
  await dialog.getByRole("button", { name: "试算调整影响", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "已核对试算、关联单据和调整依据" }).check();
  const request = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/point-adjustment-requests"),
  );
  await dialog.getByRole("button", { name: "提交审批", exact: true }).click();
  const response = await request;
  expect(response.status()).toBe(200);
  const result = (await response.json()).data as {
    pointAdjustmentRequestId: string;
    approval: { status: string };
  };
  expect(result.approval.status).toBe("pending");
  await expect(dialog).toBeHidden();
  const account = PointAccountDetailSchema.parse(await read(page, `/point-accounts/${f.entityId}`));
  expect(account.spendablePoints).toBe(f.spendablePoints);
  expect(account.notices.pendingAdjustment?.pointAdjustmentRequestId).toBe(
    result.pointAdjustmentRequestId,
  );
  await shot(page, "accounts-pending");
  const withdrawn = await write(
    page,
    `/point-adjustment-requests/${result.pointAdjustmentRequestId}/withdraw`,
    { note: "W417演练结束，撤回本人的未执行申请" },
    `w417-withdraw:${crypto.randomUUID()}`,
  );
  expect(withdrawn.status()).toBe(200);
  await page.goto(`/orders/renewals?q=${encodeURIComponent(f.entityName)}`);
  await expect(page.getByRole("heading", { name: "套餐到期", exact: true })).toBeVisible();
  await expect(page.getByText("暂无符合条件的周期", { exact: true })).toBeVisible();
  await shot(page, "renewals-empty");
  expect(errors).toEqual([]);
});

test("线下真实建单后登记直传入库再代传，独立付款单五子页签与财务结论分开", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await ensureLiveStepUp(page);
  await page.goto("/orders?view=payments");
  await page.getByRole("button", { name: "线下开单", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "线下开立付款单", exact: true });
  const entity = dialog.getByRole("combobox", { name: "付款主体", exact: true });
  await entity.fill(f.entityName);
  await option(page, `${f.entityName} · ${f.prefix}门店`);
  await dialog.getByLabel("付款内容", { exact: true }).click();
  await option(page, "积分包");
  await dialog.getByLabel("积分包", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: `${f.pack.points}积分` })
    .first()
    .click();
  await dialog
    .getByLabel("合同编号", { exact: true })
    .fill(`SYNTHETIC-W417-${f.entityId.slice(-8)}`);
  await dialog.getByRole("checkbox", { name: "已核对主体、合同、服务端金额与生效说明" }).check();
  await shot(page, "offline-confirm");
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/admin/payment-orders",
  );
  await dialog.getByRole("button", { name: "建立待付款单", exact: true }).click();
  const creation = await created;
  expect(creation.status()).toBe(200);
  const order = PaymentOrderAdminDetailSchema.parse((await creation.json()).data);
  expect(order.entity.entityId).toBe(f.entityId);
  expect(order.status).toBe("pending_payment");
  expect(order.amountFen).toBe(f.pack.priceFen);
  const proof = page.getByRole("dialog", { name: "代传银行转账凭证", exact: true });
  await expect(page.getByRole("dialog", { name: "独立付款单详情", exact: true })).toHaveCount(0);
  await expect(proof.getByRole("button", { name: "提交收款审核", exact: true })).toBeDisabled();
  await proof.locator('input[type="file"]').setInputFiles({
    name: f.receipt.name,
    mimeType: f.receipt.mime,
    buffer: Buffer.from(f.receipt.base64, "base64"),
  });
  await expect(proof.getByRole("button", { name: "提交收款审核", exact: true })).toBeEnabled();
  await shot(page, "offline-stored-receipt");
  const submitted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/payment-orders/${order.paymentOrderId}/transfer-proofs`),
  );
  await proof.getByRole("button", { name: "提交收款审核", exact: true }).click();
  const sent = await submitted;
  expect(sent.status()).toBe(200);
  const uploaded = TransferProofDetailSchema.parse((await sent.json()).data);
  expect(uploaded.paymentOrderId).toBe(order.paymentOrderId);
  await expect(proof).toBeHidden();
  await expect(page.getByRole("dialog", { name: "独立付款单详情", exact: true })).toBeVisible();
  const observed = PaymentOrderAdminDetailSchema.parse(
    await read(page, `/payment-orders/${order.paymentOrderId}`),
  );
  expect(observed.status).toBe("pending_confirmation");
  expect(observed.paidAmountFen).toBe(0);
  await page.goto(`/orders?view=payments&paymentId=${order.paymentOrderId}&payNo=${order.orderNo}`);
  const drawer = page.getByRole("dialog", { name: "独立付款单详情", exact: true });
  await expect(drawer).toContainText(order.orderNo);
  for (const name of ["支付记录", "转账凭证", "退款与发票", "操作日志", "付款信息"]) {
    await drawer.getByRole("tab", { name, exact: true }).click();
    await expect(drawer).toBeVisible();
  }
  await shot(page, "payment-detail-tabs");
  // 清理本包在办通过真实驳回，不伪造付款、删事实或倒拨审核时间；旧到账用例按自己三主体q隔离。
  const dict = await read<{ items: { code: string; isEnabled: boolean }[] }>(
      page,
      "/dict-items?typeKey=reject_reason&scene=transfer",
    ),
    reason = dict.items.find((r) => r.isEnabled);
  expect(reason).toBeDefined();
  const rejected = await write(
    page,
    `/transfer-proofs/${uploaded.transferProofId}/reject`,
    {
      lockVersion: uploaded.lockVersion,
      reasonCode: reason!.code,
      note: "W417仅虚构回单演练，未有真实到账，结束后驳回",
    },
    `w417-reject:${crypto.randomUUID()}`,
  );
  expect(rejected.status()).toBe(200);
  expect(errors).toEqual([]);
});
