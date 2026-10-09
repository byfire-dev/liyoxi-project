import { expect, test } from "@playwright/test";
import type { components } from "@liyoxi/contract/types/admin";
import { liveContext, recordErrors } from "./live-context";
import { api, select, shot, write } from "./w206-helpers";

type Detail = components["schemas"]["RoleDetail"];
const body = (role: Detail) => ({
  moduleLevels: role.moduleLevels,
  actions: role.actions,
  dataScope: role.dataScope,
  lockVersion: role.lockVersion,
});

test("角色真实13模块、超级管理员锁定，默认只改草稿并可取消", async ({ page }) => {
  const errors = recordErrors(page);
  await page.goto("/sys/roles?role=super_admin");
  const matrix = page.getByRole("table", { name: "模块权限", exact: true });
  await expect(matrix.getByRole("row")).toHaveCount(14);
  await expect(page.getByText("超级管理员配置锁定，不可编辑。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑权限", exact: true })).toHaveCount(0);
  for (const radio of await matrix.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await shot(page, "w206-roles-locked");
  await page.goto("/sys/roles?role=cs");
  await expect(page.getByRole("button", { name: "编辑权限", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑权限", exact: true }).click();
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/v1/admin/roles/cs")
      writes++;
  });
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复默认", exact: true })).toBeEnabled();
  expect(writes).toBe(0);
  await shot(page, "w206-roles-editable");
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑权限", exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect(errors).toEqual([]);
});

test("角色全量保存走真实版本，409刷新后必须重新编辑确认", async ({ page }) => {
  const original = await api<Detail>(page, "/roles/cs");
  try {
    await page.goto("/sys/roles?role=cs");
    await page.getByRole("button", { name: "编辑权限", exact: true }).click();
    await select(page, "数据范围", original.dataScope === "all" ? "本人负责" : "全部");
    const changed = await write<Detail>(page, "/roles/cs", "PUT", body(original));
    expect(changed.lockVersion).toBeGreaterThan(original.lockVersion);
    const conflict = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/api/v1/admin/roles/cs",
    );
    await page.getByRole("button", { name: "保存权限", exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(
      page.getByText("角色已被他人修改，已刷新当前版本。请重新核对后编辑和保存。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "保存权限", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑权限", exact: true }).click();
    await select(page, "数据范围", original.dataScope === "all" ? "本人负责" : "全部");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/api/v1/admin/roles/cs",
    );
    await page.getByRole("button", { name: "保存权限", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("角色已保存；员工刷新页面后生效。", { exact: true })).toBeVisible();
    const actual = await api<Detail>(page, "/roles/cs");
    expect(actual.dataScope).toBe(original.dataScope === "all" ? "own" : "all");
    expect(Object.keys(actual.moduleLevels)).toHaveLength(13);
    expect(Object.keys(actual.actions).sort()).toEqual(Object.keys(original.actions).sort());
  } finally {
    const current = await api<Detail>(page, "/roles/cs");
    await write(page, "/roles/cs", "PUT", { ...body(original), lockVersion: current.lockVersion });
  }
});

test("实际财务查看身份角色页只读，直接写接口仍403", async ({ browser }) => {
  const live = liveContext();
  const { viewer } = (
    live.fixtures as {
      fixtures: { w207: { viewer: { phone: string; password: string; w206RecoveryCode: string } } };
    }
  ).fixtures.w207;
  const context = await browser.newContext({
    baseURL: live.origin,
    viewport: { width: 1366, height: 768 },
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await context.newPage();
    await page.goto("/login?redirect=%2Fsys%2Froles%3Frole%3Dcs");
    await page.getByLabel("手机号", { exact: true }).fill(viewer.phone);
    await page.getByLabel("密码", { exact: true }).fill(viewer.password);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("radio", { name: "恢复码", exact: true }).check();
    await page.getByRole("textbox", { name: "恢复码", exact: true }).fill(viewer.w206RecoveryCode);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("当前权限只读。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑权限", exact: true })).toHaveCount(0);
    const role = await api<Detail>(page, "/roles/cs");
    const denied = await page.request.put("/api/v1/admin/roles/cs", {
      data: body(role),
      headers: {
        Origin: live.origin,
        "X-LYX-Admin": "1",
        "Idempotency-Key": `w206-read:${crypto.randomUUID()}`,
      },
    });
    expect(denied.status()).toBe(403);
    await shot(page, "w206-roles-readonly");
  } finally {
    await context.close();
  }
});
