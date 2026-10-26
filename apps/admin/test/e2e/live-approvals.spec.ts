import { expect, test } from "@playwright/test";
import { recordErrors } from "./live-context";
import { api, shot, w206 } from "./w206-helpers";
import { kindLabels } from "../../src/features/approval/model";
import type {
  ApprovalCounts,
  ApprovalDetail,
  ApprovalItem,
} from "../../src/features/approval/model";

test("我的审批只显示真实登记类型，摘要同筛选、分页URL与详情处理链", async ({ page }) => {
  const errors = recordErrors(page);
  await page.goto("/approvals?tab=all&pageSize=13&uiOnly=x");
  await expect(page.getByRole("heading", { name: "我的待审批", exact: true })).toBeVisible();
  const counts = await api<ApprovalCounts>(page, "/approvals/summary");
  expect(counts.items.length).toBeGreaterThan(0);
  await expect(
    page.getByText(`待本人处理 ${counts.total.todo} · 超期 ${counts.total.overdue}`, {
      exact: true,
    }),
  ).toBeVisible();
  const kindFilter = page.getByRole("combobox", { name: "全部已登记类型", exact: true });
  await kindFilter.click();
  await expect(kindFilter).toHaveAttribute("aria-activedescendant", /.+/);
  const firstActiveId = (await kindFilter.getAttribute("aria-activedescendant"))!;
  const expectedKinds = counts.items.map((item) => item.kind);
  const actualKinds: string[] = [];
  // 虚拟列表只渲染窗口；沿真实键盘焦点遍历，逐项核原始 kind 与可见标签。
  for (let index = 0; index < counts.items.length; index += 1) {
    const activeId = (await kindFilter.getAttribute("aria-activedescendant"))!;
    const option = page.locator(`[id=${JSON.stringify(activeId)}]`);
    await expect(option).toHaveAttribute("role", "option");
    const kind = (await option.textContent())!.trim();
    expect(actualKinds).not.toContain(kind);
    expect(expectedKinds).toContain(kind);
    await expect(
      page.locator(
        ".ant-select-dropdown:visible .ant-select-item-option-active .ant-select-item-option-content",
      ),
    ).toHaveText(kindLabels[kind] ?? kind);
    actualKinds.push(kind);
    await kindFilter.press("ArrowDown");
    if (counts.items.length > 1)
      await expect(kindFilter).not.toHaveAttribute("aria-activedescendant", activeId);
  }
  // 完整一圈必须回到起点，额外选项同样不能漏过。
  await expect(kindFilter).toHaveAttribute("aria-activedescendant", firstActiveId);
  expect(actualKinds).toHaveLength(counts.items.length);
  expect([...actualKinds].sort()).toEqual([...expectedKinds].sort());
  await page.keyboard.press("Escape");
  for (const tab of ["todo", "done_today"]) {
    await page.goto(`/approvals?tab=${tab}`);
    const actual = await api<{ items: ApprovalItem[]; total: number }>(
      page,
      `/approvals?tab=${tab}&page=1&pageSize=20`,
    );
    if (actual.items.length === 0)
      await expect(page.getByText("暂无审批", { exact: true })).toBeVisible();
    else
      await expect(page.locator(".ant-table-tbody > tr[data-row-key]")).toHaveCount(
        actual.items.length,
      );
  }
  const missing = "W206没有对应审批的精确查询";
  await page.goto(`/approvals?tab=all&q=${encodeURIComponent(missing)}`);
  expect(
    (await api<{ total: number }>(page, `/approvals?tab=all&q=${encodeURIComponent(missing)}`))
      .total,
  ).toBe(0);
  await expect(page.getByText("没有符合条件的审批", { exact: true })).toBeVisible();
  const fixture = w206();
  expect(fixture.approvals.length).toBeGreaterThan(0);
  const id = fixture.approvals[0]!.id;
  await page.goto(`/approvals?tab=all&id=${id}`);
  const detail = await api<ApprovalDetail>(page, `/approvals/${id}`);
  const drawer = page.getByRole("dialog", { name: "审批详情", exact: true });
  await expect(drawer).toContainText(detail.summary.title);
  if (detail.kind === "finance_config_change")
    await expect(drawer.getByRole("link")).toHaveCount(0);
  else if (["qualification", "channel_account", "launch_link"].includes(detail.kind)) {
    const link = drawer.getByRole("link", { name: /业务/ });
    await expect(link).toHaveAttribute("href", new RegExp(`\\?id=${id}$`));
    expect(await link.getAttribute("href")).not.toMatch(/^https?:/);
  }
  await shot(page, "w206-approval-detail");
  expect(errors).toEqual([]);
});

test("日期首次使用真实Tab进出和Esc关闭，筛选保持北京时间URL", async ({ page }) => {
  await page.goto("/approvals?tab=all");
  const start = page.getByPlaceholder("开始日期", { exact: true });
  await start.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(start).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(start).not.toBeFocused();
  await start.click();
  await expect(page.locator(".ant-picker-dropdown:visible")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-picker-dropdown:visible")).toHaveCount(0);
  await page.goto("/approvals?tab=all&submittedFrom=2020-01-01&submittedTo=2030-12-31");
  await expect(
    page.getByText("2020-01-01 至 2030-12-31（北京时间）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除日期", exact: true }).click();
  await expect(page).not.toHaveURL(/submittedFrom|submittedTo/);
});
