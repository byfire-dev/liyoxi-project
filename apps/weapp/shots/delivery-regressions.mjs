import { expect } from "@playwright/test";
const button = (page, label) => page.locator(".lyx-button").filter({ hasText: label });
const calls = (page) => page.evaluate(() => globalThis.__LYX_DELIVERY_CALLS__);
export async function deliveryRegression(page, scene) {
  if (scene === "plan-pending") {
    await button(page, "确认方案").click();
    const confirm = page.locator(".lyx-sheet .lyx-button").filter({ hasText: "确认方案" });
    const path = await page.evaluate(() => globalThis.__LYX_DELIVERY_CALLS__[0].path + "/confirm");
    await page.evaluate((path) => globalThis.__LYX_DELIVERY_CONTROL__.fail(path), path);
    await confirm.click();
    await expect(page.getByText("网络暂时中断，请重试", { exact: true })).toBeVisible();
    await confirm.evaluate((node) => {
      node.click();
      node.click();
    });
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const result = await calls(page),
      writes = result.filter((c) => c.path === path);
    expect(writes).toHaveLength(2);
    expect(writes[0].key).toBe(writes[1].key);
    expect(writes[1].data).toEqual({ versionNo: 2 });
    expect(
      result.filter((c) => c.path === path.replace("/confirm", "") && c.method === "GET").length,
    ).toBeGreaterThan(1);
  }
  if (scene === "plan-change") {
    await button(page, "提交修改说明").click();
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const write = (await calls(page)).find((c) => c.path.endsWith("request-change"));
    expect(write.data).toEqual({ kinds: ["launch_date"], note: "请调整到月底上线" });
    expect(write.key).toBeTruthy();
  }
  if (scene === "sample-viewed") {
    await page.locator(".lyx-footer-bar .lyx-button").click();
    await page.locator(".lyx-sheet .lyx-button").click();
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const list = await calls(page),
      write = list.find((c) => c.path.endsWith("/confirm"));
    expect(write.data).toEqual({ versionNo: 2, viewedVia: "album", hasViewed: true });
    expect(write.key).toBeTruthy();
    expect(list.filter((c) => c.path.endsWith("/sample")).length).toBeGreaterThan(2);
    await page.evaluate(() => globalThis.__LYX_DELIVERY_CONTROL__.nextSample());
    await button(page, "刷新样片").click();
    await expect(page.getByText("我已查看第 3 版样片", { exact: true })).toBeVisible();
    await expect(page.locator(".lyx-checkbox")).not.toHaveClass(/lyx-checkbox--checked/);
    await expect(page.locator(".lyx-checkbox")).toHaveClass(/lyx-checkbox--disabled/);
    const path = "/m/samples/00000000-0000-4000-8000-000000000021/download-urls";
    await page.evaluate((path) => globalThis.__LYX_DELIVERY_CONTROL__.hold(path), path);
    await button(page, "保存样片到相册查看").evaluate((node) => {
      node.click();
      node.click();
    });
    await page.waitForFunction(
      (path) => globalThis.__LYX_DELIVERY_CALLS__.some((c) => c.path === path),
      path,
    );
    const before = (await calls(page)).length;
    await page.evaluate(() => globalThis.__LYX_DELIVERY_CONTROL__.clerk());
    await expect(page.getByText("仅老板可查看，请切换到老板门店", { exact: true })).toBeVisible();
    await page.evaluate(() => globalThis.__LYX_DELIVERY_CONTROL__.release(true));
    await page.waitForTimeout(100);
    expect((await calls(page)).length).toBe(before);
    expect((await calls(page)).filter((c) => c.path === path)).toHaveLength(1);
    await expect(page.getByText("迟到保存失败", { exact: true })).toHaveCount(0);
  }
  if (scene === "tasks-submit") {
    await button(page, "提交核验").click();
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const list = await calls(page),
      write = list.find((c) => c.path.endsWith("/submit"));
    expect(write.data).toEqual({
      linkKind: "collection",
      collectionUrl: "https://example.test/collection",
      reportedEpisodeCount: 30,
      actualLaunchDate: "2026-10-07",
    });
    expect(write.key).toBeTruthy();
    expect(list.filter((c) => c.path.startsWith("/m/launch-tasks?")).length).toBeGreaterThan(1);
    expect(list.filter((c) => c.path.endsWith("/summary")).length).toBeGreaterThan(1);
  }
}
