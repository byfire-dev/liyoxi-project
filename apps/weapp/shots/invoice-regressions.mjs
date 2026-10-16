import { expect } from "@playwright/test";
export async function runInvoiceRegression(page, scene) {
  const root = page.locator(".taro_page_stationed:not(.taro_page_shade) #invoices-ready");
  await expect(root).toBeVisible();
  const records = () => root.locator(".lyx-tabs__item").filter({ hasText: "开票记录" }).click();
  if (scene === "invoice-empty") {
    await expect(root).toContainText("暂无可开票的付款");
    await records();
    await expect(root).toContainText("暂无开票记录");
    await root.locator(".lyx-tabs__item").filter({ hasText: "可开票" }).click();
  } else if (scene === "invoice-apply-error") {
    await root.locator(".lyx-button").filter({ hasText: "申请开票" }).click();
    const sheet = page.locator(".lyx-sheet").filter({ hasText: "接收邮箱" });
    await sheet.locator("input").fill("finance@example.invalid");
    await sheet.locator(".lyx-button").filter({ hasText: "提交申请" }).click();
    await expect(sheet).toContainText("开票条件已变化");
    await expect(root).not.toContainText("已提交开票申请");
  } else {
    await records();
    await expect(root).toContainText(scene === "invoice-pending" ? "财务正在审核" : "邮件已受理");
    await expect(root).toContainText("2026-10-17");
    if (scene === "invoice-issued") {
      const blue = root.locator(".lyx-button").filter({ hasText: "下载发票（PDF）" });
      await blue.click();
      await expect(blue).not.toHaveClass(/loading/);
      await blue.click();
      await expect(blue).not.toHaveClass(/loading/);
      await root.locator(".lyx-button").filter({ hasText: "下载红字发票（OFD）" }).click();
      await expect(root).toContainText("此设备暂不支持该文件格式");
      const calls = await page.evaluate(() => globalThis.__LYX_INVOICE_CALLS__ ?? []);
      expect(calls.filter((c) => c.path.endsWith("/download-urls"))).toHaveLength(3);
      expect(calls.filter((c) => c.path.endsWith("/download-urls")).every((c) => !c.key)).toBe(
        true,
      );
      await root.locator(".lyx-button").filter({ hasText: "重新加载" }).click();
      await expect(root).not.toContainText("此设备暂不支持该文件格式");
      await expect(root).toContainText("蓝字票号");
      await expect(root).toContainText("红字票号");
      await root.evaluate((element) => element.scrollIntoView({ block: "start" }));
    }
  }
  if (scene !== "invoice-apply-error") await root.scrollIntoViewIfNeeded();
}
