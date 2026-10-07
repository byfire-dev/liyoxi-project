import { mkdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

test("主从页：选中 URL 可恢复，行内按钮独立，旧详情不会落到新记录", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dev/master-detail");
  const detail = page.getByRole("complementary", { name: "选中组详情" });
  const table = page.getByRole("region", { name: "区域组列表" });
  await expect(detail.getByText("请选择一条记录")).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /手机号.*已脱敏/ })).toBeVisible();
  await table
    .getByRole("row", { name: /成都组/ })
    .getByRole("cell")
    .first()
    .click();
  await expect(page).toHaveURL(/id=a/);
  await expect(detail.getByText("样例记录 A")).toBeVisible();
  await table
    .getByRole("row", { name: /重庆组/ })
    .getByRole("button", { name: "查看说明" })
    .click();
  await expect(page.getByText("行内操作：1")).toBeVisible();
  await expect(page).toHaveURL(/id=a/);
  await table.getByRole("row", { name: /重庆组/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/id=b/);
  await expect(table.getByRole("row", { name: /重庆组/ })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByText("样例记录 B")).toBeVisible();
  await page.getByRole("button", { name: "模拟 A 的过期响应" }).click();
  await expect(detail.getByLabel("详情加载中")).toBeVisible();
  await expect(detail.getByText("样例记录 A")).toHaveCount(0);
  await page.getByRole("button", { name: "重新获取详情" }).click();
  await expect(detail.getByText("样例记录 B")).toBeVisible();
  await page.goBack();
  await expect(detail.getByText("样例记录 A")).toBeVisible();
  await page.reload();
  await expect(detail.getByText("样例记录 A")).toBeVisible();
  const width = await detail.evaluate((node) => node.getBoundingClientRect().width);
  expect(width).toBe(360);
  await page.getByRole("button", { name: "列表错误", exact: true }).click();
  await expect(table.getByText("样例列表暂时无法加载")).toBeVisible();
  await table.getByRole("button", { name: "重新加载" }).click();
  await expect(table.getByRole("row", { name: /成都组/ })).toBeVisible();
  await page.getByRole("button", { name: "列表为空", exact: true }).click();
  await expect(table.getByText("暂无记录")).toBeVisible();
  await page.getByRole("button", { name: "正常列表", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: "dist/e2e-shots/w202-master-detail.png", animations: "disabled" });
  expect(errors).toEqual([]);
});

test("配置页：真实只读、提交等待与失败反馈，双击只提交一次", async ({ page }) => {
  await page.goto("/dev/config");
  const form = page.getByRole("form", { name: "样例配置表单" });
  const name = form.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("修改后的配置");
  await form.getByRole("button", { name: "保存配置" }).dblclick();
  await expect(page.getByRole("status")).toHaveText("提交次数：1");
  await expect(name).toBeDisabled();
  await expect(form).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "完成提交" }).click();
  await expect(name).toBeEnabled();
  await page.getByRole("button", { name: "切换只读" }).click();
  await expect(name).toBeDisabled();
  await expect(form.getByRole("button", { name: "保存配置" })).toHaveCount(0);
  await expect(form.getByText("当前配置为只读")).toBeVisible();
  await page.getByRole("button", { name: "切换只读" }).click();
  await page.getByRole("button", { name: "模拟提交失败" }).click();
  await form.getByRole("button", { name: "保存配置" }).click();
  await expect(form.getByRole("alert")).toHaveText("没有保存成功，请稍后重试");
  await expect(name).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: "dist/e2e-shots/w202-config.png", animations: "disabled" });
});

test("已有日期范围：真实键盘进入、Esc关闭并Tab离开", async ({ page }) => {
  await page.goto("/dev/config");
  const form = page.getByRole("form", { name: "样例配置表单" });
  await form.getByRole("textbox", { name: "名称", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(form.getByPlaceholder("开始日期")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ant-picker-dropdown")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-picker-dropdown")).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(form.getByPlaceholder("结束日期")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("textbox", { name: "备注（选填）" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(form.getByPlaceholder("结束日期")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(form.getByPlaceholder("开始日期")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(form.getByRole("textbox", { name: "名称", exact: true })).toBeFocused();
  await form.getByPlaceholder("开始日期").fill("2026-10-01");
  await page.keyboard.press("Tab");
  await form.getByPlaceholder("结束日期").fill("2026-10-02");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("已选日期范围")).toHaveText("2026-10-01 至 2026-10-02");
  await expect(page.getByRole("status")).toHaveText("提交次数：0");
});

test("实际 ECharts：按需绘图、尺寸变化、隐藏恢复与卸载重挂", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dev/chart");
  const container = page.getByRole("region", { name: "图表容器" });
  const chart = container.getByRole("img", { name: /样例各组计数/ });
  const canvas = chart.locator("canvas");
  await expect(canvas).toHaveCount(1);
  const width = await canvas.evaluate((node) => node.getBoundingClientRect().width);
  await page.getByRole("button", { name: "切换宽度" }).click();
  await expect
    .poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width))
    .toBeLessThan(width);
  await page.getByRole("button", { name: "切换隐藏" }).click();
  await expect(chart).toBeHidden();
  await page.getByRole("button", { name: "切换宽度" }).click();
  await page.getByRole("button", { name: "切换隐藏" }).click();
  await expect
    .poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width))
    .toBe(width);
  for (const type of ["折线图", "饼图"]) {
    await page.getByRole("combobox", { name: "图表类型" }).click();
    await page.getByTitle(type, { exact: true }).click();
    await expect(canvas).toHaveCount(1);
  }
  await page.getByRole("button", { name: "切换挂载" }).click();
  await expect(canvas).toHaveCount(0);
  await page.getByRole("button", { name: "切换挂载" }).click();
  await expect(canvas).toHaveCount(1);
  await page.getByRole("button", { name: "空数据", exact: true }).click();
  await expect(container.getByText("暂无图表数据")).toBeVisible();
  await expect(container.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "加载错误", exact: true }).click();
  await expect(container.getByText("样例图表加载失败")).toBeVisible();
  await container.getByRole("button", { name: "重新加载" }).click();
  await expect(canvas).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: "dist/e2e-shots/w202-chart.png", animations: "disabled" });
  expect(errors).toEqual([]);
});

test("缺失控件：受控原生单选、禁用、月份跨年、展示语义与旧驳回等待守卫", async ({ page }) => {
  await page.goto("/dev/shared-controls");
  const capsule = page.getByRole("group", { name: "区域胶囊" });
  await capsule.getByRole("radio", { name: "甲组", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(capsule.getByRole("radio", { name: "乙组", exact: true })).toBeChecked();
  const reasons = page.getByRole("group", { name: "驳回原因样例" });
  await reasons.getByText("图片模糊", { exact: true }).click();
  await expect(reasons.getByRole("radio", { name: "图片模糊", exact: true })).toBeChecked();
  await page.getByRole("group", { name: "成员单选卡" }).getByText("乙组", { exact: true }).click();
  await page.getByRole("button", { name: "下一个月" }).click();
  await expect(page.getByText("2027 年 1 月", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一个月" }).click();
  await expect(page.getByText("2026 年 12 月", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "禁用选择控件" }).check();
  await expect(capsule.getByRole("radio", { name: "甲组", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下一个月" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "禁用选择控件" }).uncheck();
  await expect(page.getByText("138****0001").first()).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toContainText("处理中");
  const log = page.getByRole("table", { name: "样例操作日志" });
  await expect(log.getByRole("columnheader")).toHaveCount(3);
  await expect(log.getByText("林可")).toBeVisible();
  await expect(page.getByRole("group", { name: "样例变更前后" })).toContainText(
    "新名称：成都一区组",
  );
  await page.setViewportSize({ width: 1440, height: 1400 });
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({
    path: "dist/e2e-shots/w202-shared-controls.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "打开通用驳回样例" }).click();
  const modal = page.getByRole("dialog", { name: "通用驳回样例" });
  await modal.getByRole("textbox").fill("请补充清晰图片");
  await modal.getByRole("button", { name: "确认驳回", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await expect(modal.getByRole("textbox")).toBeDisabled();
  await modal.getByRole("button", { name: "完成样例提交" }).click();
  await expect(modal).toBeHidden();
});
