import { expect, test } from "@playwright/test";
import { FinanceConfigViewSchema } from "@liyoxi/contract";
import { recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";
import { readConfig, settingsFixture, settingsShot } from "./live-finance-settings-support";

test("购买入口策略：逐键输入复合版本与多行主体，真实提议再撤回", async ({ page }) => {
  const fixture = settingsFixture(),
    errors = recordErrors(page);
  await ensureLiveStepUp(page);
  await page.goto("/finance/payments");
  await page.getByRole("button", { name: "受控财务配置", exact: true }).click();
  await page.getByRole("button", { name: "提议变更", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "提议财务配置变更", exact: true });
  await dialog.getByRole("combobox", { name: "配置项目", exact: true }).click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("购买入口策略", { exact: true })
    .click();
  while (await dialog.getByRole("button", { name: /^移除规则 / }).count())
    await dialog
      .getByRole("button", { name: /^移除规则 / })
      .first()
      .click();
  await dialog.getByRole("button", { name: "新增购买规则", exact: true }).click();
  const version = dialog.getByLabel("客户端版本范围", { exact: true }),
    entities = dialog.getByRole("textbox", {
      name: "商家主体编号（每行一个，留空为不限）",
      exact: true,
    });
  await version.pressSequentially(">=1.0.0 <2.0.0");
  await entities.pressSequentially(fixture.entityIds[0]!);
  await entities.press("Enter");
  await entities.pressSequentially(fixture.entityIds[1]!);
  await expect(version).toHaveValue(">=1.0.0 <2.0.0");
  await expect(entities).toHaveValue(fixture.entityIds.join("\n"));
  await dialog.getByRole("combobox", { name: "规则1入口模式", exact: true }).click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("隐藏入口", { exact: true })
    .click();
  await dialog.getByLabel("变更说明", { exact: true }).fill("本轮虚构入口规则页面演练");
  await dialog
    .getByRole("checkbox", { name: "我已核对当前值、提议值及变更影响", exact: true })
    .check();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/admin/finance-config-revisions",
  );
  await dialog.getByRole("button", { name: "提交提议", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const created = FinanceConfigViewSchema.parse((await response.json()).data);
  await expect(dialog).toBeHidden();
  const detail = page.getByRole("complementary", { name: "配置详情与审批", exact: true });
  await expect(detail.getByText("待审批", { exact: true })).toBeVisible();
  const pending = await readConfig(page, created.financeConfigRevisionId);
  expect(pending).toMatchObject({
    state: "pending",
    configKey: "purchase_policy",
    payload: {
      rules: [
        {
          when: { versionRange: ">=1.0.0 <2.0.0", entityIds: fixture.entityIds },
          then: { mode: "hidden" },
        },
      ],
    },
  });
  await expect(detail.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "撤回", exact: true }).click();
  const withdraw = page.getByRole("dialog", { name: "撤回购买入口策略", exact: true });
  await withdraw
    .getByRole("checkbox", { name: "我已核对配置差异、变更说明和生效规则", exact: true })
    .check();
  const withdrawn = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      res.url().endsWith(`/finance-config-revisions/${created.financeConfigRevisionId}/withdraw`),
  );
  await withdraw.getByRole("button", { name: "确认撤回", exact: true }).click();
  expect((await withdrawn).status()).toBe(200);
  await expect(withdraw).toBeHidden();
  await expect(detail.getByText("已撤回", { exact: true })).toBeVisible();
  expect((await readConfig(page, created.financeConfigRevisionId)).state).toBe("withdrawn");
  await settingsShot(page, "w418-settings-policy-withdrawn");
  expect(errors).toEqual([]);
});
