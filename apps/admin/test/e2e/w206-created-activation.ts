import { expect, test } from "@playwright/test";
import { liveContext } from "./live-context";
import { confirm, openStaff, shot, totp } from "./w206-helpers";

/** 放在原新增员工验收之后，只消费该用例已创建的员工，不改变原列表/分页基数。 */
export function registerW206CreatedActivationTest() {
  test("已新增员工补发真实一次码并完成真实激活，关闭后不保留码", async ({ page, browser }) => {
    const live = liveContext();
    const { newStaff } = (
      live.fixtures as { fixtures: { staff: { newStaff: { name: string; phone: string } } } }
    ).fixtures.staff;
    await openStaff(page, newStaff.name);
    await page.getByRole("button", { name: "补发激活码", exact: true }).click();
    await page
      .getByRole("dialog", { name: "补发激活码", exact: true })
      .getByRole("button", { name: "核对并继续", exact: true })
      .click();
    await confirm(page, "补发激活码");
    const modal = page.getByRole("dialog", { name: "一次性激活码", exact: true });
    const code = modal.getByLabel("员工激活码", { exact: true });
    await expect(code).toHaveText(/^[A-Z0-9]{8}$/);
    const value = await code.innerText();
    await shot(page, "w206-created-activation-masked");
    await modal.getByRole("button", { name: "我已记下，关闭", exact: true }).click();
    await expect(code).toHaveCount(0);
    const context = await browser.newContext({
      baseURL: live.origin,
      viewport: { width: 1366, height: 768 },
      storageState: { cookies: [], origins: [] },
    });
    try {
      const personal = await context.newPage();
      await personal.goto("/login?redirect=%2Forders");
      await personal.getByRole("button", { name: "首次登录，激活账号", exact: true }).click();
      await personal.getByLabel("手机号", { exact: true }).fill(newStaff.phone);
      await personal.getByLabel("激活码", { exact: true }).fill(value);
      await personal.getByLabel("新密码", { exact: true }).fill("Liyoxi-2026-newstaff");
      await personal.getByRole("button", { name: "设置密码并继续", exact: true }).click();
      const secret = personal.getByLabel("手输密钥", { exact: true });
      await expect(secret).not.toHaveValue("");
      await personal
        .getByLabel("6 位动态口令", { exact: true })
        .fill(totp(await secret.inputValue()));
      await personal.getByRole("button", { name: "验证并绑定", exact: true }).click();
      await expect(personal.getByLabel("恢复码清单", { exact: true }).locator("code")).toHaveCount(
        10,
      );
      await personal.getByRole("checkbox", { name: "我已保存恢复码", exact: true }).check();
      await personal.getByRole("button", { name: "进入后台", exact: true }).click();
      await expect(personal.getByRole("button", { name: "用户菜单", exact: true })).toContainText(
        newStaff.name,
      );
      const me = await personal.request.get("/api/v1/admin/auth/me");
      expect(me.status()).toBe(200);
      expect(
        ((await me.json()) as { data: { staff: { name: string; roleKey: string } } }).data.staff,
      ).toMatchObject({ name: newStaff.name, roleKey: "delivery_manager" });
      await expect(personal.getByLabel("恢复码清单", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
