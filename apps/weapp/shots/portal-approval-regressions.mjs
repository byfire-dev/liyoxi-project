import { expect } from "@playwright/test";

/** Private H5 presentation assertions; approval responses are explicit contract fixtures. */
export async function portalApprovalRegression(page, scene) {
  const active = page.locator(".taro_page_stationed:not(.taro_page_shade)");
  const content = active.locator("#portal-approve-ready");
  const button = (name) =>
    content.locator(".lyx-button").filter({ hasText: new RegExp(`^${name}$`) });
  const calls = () => page.evaluate(() => globalThis.__LYX_PORTAL_APPROVAL_CALLS__ ?? []);
  await expect(content).toBeVisible();
  await expect(button("扫描电脑登录码")).toHaveCount(0);
  await content.locator("input").fill("12ABCDEF");
  await button("核对这台电脑").click();
  if (scene === "portal-approve-expired") {
    await expect(content).toContainText("登录码已过期");
    await expect(content.locator("input")).toBeVisible();
    await expect(content).not.toContainText("确认电脑下载授权");
    await expect(button("允许这台电脑下载")).toHaveCount(0);
    expect(await calls()).toEqual([
      { path: "/m/portal-tickets/lookup?code=12ABCDEF", method: "GET" },
    ]);
    return;
  }
  await expect(content).toContainText("Chrome · macOS");
  await expect(content).toContainText("邻里咖啡 · 福田店");
  await expect(content).toContainText("深圳");
  expect(await calls()).toEqual([
    { path: "/m/portal-tickets/lookup?code=12ABCDEF", method: "GET" },
  ]);
  for (const digits of ["17", "42", "83"]) await expect(button(digits)).toBeVisible();
  await expect(button("允许这台电脑下载")).toHaveClass(/lyx-button--disabled/);
  if (scene === "portal-approve-rejected") {
    await button("拒绝授权").click();
    await expect(content).toContainText("你已拒绝本次电脑登录");
  } else {
    const digits = scene === "portal-approve-mismatch" ? "42" : "17";
    await button(digits).click();
    await expect(content).toContainText(`已选择 ${digits}`);
    await expect(button("允许这台电脑下载")).not.toHaveClass(/lyx-button--disabled/);
    if (scene === "portal-approve-pair") {
      expect(await calls()).toHaveLength(1);
      return;
    }
    await button("允许这台电脑下载").click();
    await expect(content).toContainText(
      scene === "portal-approve-mismatch" ? "配对数字不一致" : "本次授权已确认",
    );
    if (scene === "portal-approve-mismatch")
      await expect(content).not.toContainText("本次授权已确认");
  }
  const written = (await calls()).filter((call) => call.method === "POST");
  expect(written).toHaveLength(1);
  expect(written[0].key).toBeTruthy();
  const reject = scene === "portal-approve-rejected";
  expect(written[0].path).toBe(
    `/m/portal-tickets/019a4500-0000-7000-8000-000000000201/${reject ? "reject" : "approve"}`,
  );
  expect(written[0].body).toEqual(
    reject ? undefined : { pairDigits: scene === "portal-approve-mismatch" ? "42" : "17" },
  );
  expect(await calls()).toHaveLength(2);
  await expect(button("允许这台电脑下载")).toHaveCount(0);
}
