import { expect } from "@playwright/test";

const field = (page, label) =>
  page.locator(".lyx-field").filter({ hasText: label }).locator("input").first();
const button = (page, label) => page.locator(".lyx-button").filter({ hasText: label });
const conflict = "资料已更新，已保留本次输入。请先刷新核对，再保存";
async function refreshConflict(page, path, save) {
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.conflict(path), path);
  await save.click();
  await expect(page.getByText(conflict, { exact: true })).toBeVisible();
  await page.locator(".lyx-text-button").filter({ hasText: "刷新并核对" }).click();
  await expect(page.locator("#profile-ready")).toBeVisible();
}
export async function profileEditRegression(page, scene) {
  const kind = scene.split("-")[0];
  const path = `/m/store-profile/${kind === "store" ? "media" : kind}`;
  const save = button(
    page,
    kind === "basic" ? "保存基础信息" : kind === "store" ? "保存门店环境" : "保存服务与价格",
  );
  const interior = page.locator(".lyx-card").filter({ hasText: "店内环境" });
  if (kind === "basic") {
    await field(page, "品牌名称").fill("  刷新仍保留的品牌  ");
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.lockBasic());
  }
  if (kind === "store") await interior.locator(".lyx-upload-grid__remove").first().click();
  if (kind === "service") {
    await page
      .locator(".profile-row")
      .first()
      .locator(".lyx-text-button")
      .filter({ hasText: "编辑" })
      .click();
    await field(page, "服务名称").fill("刷新仍保留的服务");
    await button(page, "保存本项").click();
    await field(page, "优惠活动").fill("刷新仍保留的优惠");
  }
  await refreshConflict(page, path, save);
  if (kind === "basic") await expect(field(page, "品牌名称")).toHaveValue("  刷新仍保留的品牌  ");
  if (kind === "store") await expect(interior.locator(".lyx-upload-grid__remove")).toHaveCount(2);
  if (kind === "service") {
    await expect(page.getByText("刷新仍保留的服务", { exact: true })).toBeVisible();
    await expect(field(page, "优惠活动")).toHaveValue("刷新仍保留的优惠");
  }
  if (kind === "basic") await expect(field(page, "门店名称")).toBeDisabled();
  const before = await page.evaluate(
    (path) =>
      globalThis.__LYX_PROFILE_CALLS__.filter(
        (call) => call.path === path && call.method === "PATCH",
      ).length,
    path,
  );
  await page.evaluate((path) => globalThis.__LYX_PROFILE_CONTROL__.replay(path), path);
  await save.click();
  await expect(page.getByText(conflict, { exact: true })).toHaveCount(0);
  await expect(page.locator(".lyx-button--loading")).toHaveCount(0);
  const writes = await page.evaluate(
    (path) =>
      globalThis.__LYX_PROFILE_CALLS__.filter(
        (call) => call.path === path && call.method === "PATCH",
      ),
    path,
  );
  expect(writes).toHaveLength(before + 1);
  expect(writes.at(-1).data.lockVersion).toBe(3);
  expect(writes.at(-1).idempotencyKey).not.toBe(writes.at(-2).idempotencyKey);
  const calls = await page.evaluate(
    (path) =>
      globalThis.__LYX_PROFILE_CALLS__
        .filter((call) => call.path === path)
        .map((call) => call.method),
    path,
  );
  expect(calls.slice(-2)).toEqual(["PATCH", "GET"]);
  if (kind === "basic") await expect(field(page, "品牌名称")).toHaveValue("刷新仍保留的品牌");
  await expect(
    page.locator(kind === "service" ? ".profile-photo img" : ".lyx-upload-grid__cell img").first(),
  ).toHaveAttribute("src", /data:image/);
  await profileContextRegression(page, kind);
}
export async function profileContactRegression(page) {
  const path = "/m/store-profile/contact";
  await field(page, "联系人姓名").fill("刷新仍保留的联系人");
  await page.locator(".lyx-checkbox").filter({ hasText: "使用其他号码" }).click();
  await field(page, "联系人手机号").fill("13700130000");
  const save = button(page, "保存联系人");
  await refreshConflict(page, path, save);
  await expect(field(page, "联系人姓名")).toHaveValue("刷新仍保留的联系人");
  await expect(field(page, "联系人手机号")).toHaveValue("13700130000");
  await save.click();
  await expect(page.locator(".lyx-button--loading")).toHaveCount(0);
  await expect(page.locator("#profile-ready")).toBeVisible();
  await expect(field(page, "联系人姓名")).toHaveValue("刷新仍保留的联系人");
  const writes = await page.evaluate(() =>
    globalThis.__LYX_PROFILE_CALLS__.filter(
      (call) => call.path === "/m/store-profile/contact" && call.method === "PATCH",
    ),
  );
  expect(writes.map((call) => call.data.lockVersion)).toEqual([1, 2]);
  expect(writes[1].data.phone).toBe("13700130000");
}
export async function profileAuthorizationRegression(page) {
  const start = async () => {
    await page.locator(".lyx-checkbox").filter({ hasText: "我确认所填信息" }).click();
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.defer());
    await button(page, "提交资质审核").dblclick();
    await expect
      .poll(() => page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.asks()))
      .toBe(1);
  };
  const settle = async () => {
    const before = await page.evaluate(() => ({
      calls: globalThis.__LYX_PROFILE_CALLS__.length,
      url: globalThis.location.href,
    }));
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.settle());
    expect(await page.evaluate(() => globalThis.__LYX_PROFILE_CALLS__.length)).toBe(before.calls);
    expect(page.url()).toBe(before.url);
    expect(
      await page.evaluate(() =>
        globalThis.__LYX_PROFILE_CALLS__.filter((call) =>
          call.path.endsWith("/qualification/submit"),
        ),
      ),
    ).toEqual([]);
  };
  await start();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.leave());
  await expect(page).toHaveURL(/sub\/profile\/review\/index/);
  await expect(page.locator("#profile-ready").getByText("审核进度", { exact: true })).toBeVisible();
  await expect(page.locator("#profile-ready")).toBeVisible();
  await settle();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.enter());
  await expect(page).toHaveURL(/sub\/profile\/cert\/index/);
  await expect(field(page, "联系人姓名")).toHaveValue("刷新仍保留的联系人");
  await start();
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.switchStore());
  await expect(field(page, "联系人姓名")).toHaveValue("新门店联系人");
  await expect(page.locator("#profile-ready")).toBeVisible();
  await settle();
  await expect(button(page, "提交资质审核")).not.toHaveClass(/lyx-button--loading/);
  await expect(page.locator(".lyx-checkbox").filter({ hasText: "我确认所填信息" })).not.toHaveClass(
    /lyx-checkbox--checked/,
  );
}
export async function profileContextRegression(page, kind) {
  await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.switchStore());
  await expect(page.locator("#profile-ready")).toBeVisible();
  if (kind === "basic") await expect(field(page, "品牌名称")).toHaveValue("新门店品牌");
  if (kind === "store")
    await expect(
      page.locator(".lyx-card").filter({ hasText: "店内环境" }).locator(".lyx-upload-grid__remove"),
    ).toHaveCount(3);
  if (kind === "service") {
    await expect(page.getByText("新门店服务", { exact: true })).toBeVisible();
    await expect(field(page, "优惠活动")).not.toHaveValue("刷新仍保留的优惠");
  }
  if (kind === "cert") await expect(field(page, "联系人姓名")).toHaveValue("新门店联系人");
  const label =
    kind === "basic"
      ? "品牌名称"
      : kind === "service"
        ? "优惠活动"
        : kind === "cert"
          ? "联系人姓名"
          : null;
  if (label) {
    await field(page, label).fill("登出应清理的草稿");
    await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.logout());
    await expect(field(page, label)).not.toHaveValue("登出应清理的草稿");
  }
}
