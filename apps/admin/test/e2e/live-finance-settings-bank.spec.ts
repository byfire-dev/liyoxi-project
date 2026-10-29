import { expect, test } from "@playwright/test";
import { FinanceConfigViewSchema } from "@liyoxi/contract";
import { recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";
import { readConfig, settingsFixture, settingsShot } from "./live-finance-settings-support";

test("收款账户：审批中心进入业务详情，异人批准仍等待24小时生效", async ({ page }) => {
  const f = settingsFixture(),
    errors = recordErrors(page);
  expect(f.selfApprovalRejected).toBe(true);
  const me = await page.request.get("/api/v1/admin/auth/me");
  expect(me.status()).toBe(200);
  const meId = ((await me.json()).data as { staff: { staffId: string } }).staff.staffId;
  expect(meId).not.toBe(f.requesterStaffId);
  await ensureLiveStepUp(page);
  await page.goto(`/approvals?tab=all&kind=finance_config_change&id=${f.approvalId}`);
  const approval = page.getByRole("dialog", { name: "审批详情", exact: true });
  await approval.getByRole("link", { name: "进入业务处理", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/finance/settings\\?tab=history&id=${f.bankId}$`));
  const detail = page.getByRole("complementary", { name: "配置详情与审批", exact: true });
  await expect(detail.getByText(f.changeNote, { exact: true })).toBeVisible();
  expect((await readConfig(page, f.bankId)).state).toBe("pending");
  await detail.getByRole("button", { name: "批准", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "批准对公收款账户", exact: true });
  await expect(dialog.getByRole("button", { name: "确认批准", exact: true })).toBeDisabled();
  await dialog.getByLabel("核对新账户尾四位", { exact: true }).fill(f.last4);
  await dialog
    .getByRole("checkbox", { name: "我已核对配置差异、变更说明和生效规则", exact: true })
    .check();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/finance-config-revisions/${f.bankId}/approve`),
  );
  await dialog.getByRole("button", { name: "确认批准", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(detail.getByText("已批准，待生效", { exact: true })).toBeVisible();
  const scheduled = await readConfig(page, f.bankId);
  expect(scheduled).toMatchObject({
    state: "scheduled",
    approval: { status: "approved", decidedBy: { staffId: meId } },
  });
  expect(Date.parse(scheduled.effectiveAt!) - Date.parse(scheduled.approval.decidedAt!)).toBe(
    24 * 3600_000,
  );
  const current = await page.request.get(
    "/api/v1/admin/finance-config-revisions?tab=current&configKey=bank_account&page=1&pageSize=20",
  );
  expect(current.status()).toBe(200);
  const items = ((await current.json()).data as { items: unknown[] }).items.map((item) =>
    FinanceConfigViewSchema.parse(item),
  );
  expect(items.find((item) => item.state === "effective")?.financeConfigRevisionId).toBe(
    f.baselineBankId,
  );
  expect(items.find((item) => item.financeConfigRevisionId === f.bankId)?.state).toBe("scheduled");
  expect(JSON.stringify(items)).not.toContain("6222000012344321");
  await settingsShot(page, "w418-settings-bank-scheduled");
  expect(errors).toEqual([]);
});
