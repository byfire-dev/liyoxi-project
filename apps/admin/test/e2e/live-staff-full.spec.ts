import { expect, test, type Page } from "@playwright/test";
import type { components } from "@liyoxi/contract/types/admin";
import { liveContext } from "./live-context";
import {
  api,
  clientSourceHeaders,
  confirm,
  openStaff,
  recordExpectedConflictErrors,
  select,
  shot,
  totp,
  w206,
  write,
} from "./w206-helpers";

type Detail = components["schemas"]["StaffDetail"];
type Work = components["schemas"]["OpenWorkSummary"];
type Role = components["schemas"]["RoleDetail"];
const detail = (page: Page, id: string) => api<Detail>(page, `/staff/${id}`);
const pools = (value: Detail) =>
  value.poolMemberships.map((row) => ({ pool: row.pool, cityCode: row.city?.code ?? null }));
async function command(page: Page, name: string, staffNo?: number) {
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("dialog", { name, exact: true })
    .getByRole("button", { name: "核对并继续", exact: true })
    .click();
  await confirm(page, name, staffNo);
}
async function closeCode(page: Page) {
  const modal = page.getByRole("dialog", { name: "一次性激活码", exact: true });
  await expect(modal.getByLabel("员工激活码", { exact: true })).toHaveText(/^[A-Z0-9]{8}$/);
  const code = await modal.getByLabel("员工激活码", { exact: true }).innerText();
  await shot(page, "w206-staff-activation-masked");
  await modal.getByRole("button", { name: "我已记下，关闭", exact: true }).click();
  await expect(page.getByLabel("员工激活码", { exact: true })).toHaveCount(0);
  return code;
}

test("员工同筛选计数、真实编辑409与池版本，读推荐不推进游标", async ({ page }) => {
  const fixture = w206(),
    errors = recordExpectedConflictErrors(page);
  const original = await detail(page, fixture.manager.id);
  try {
    await page.goto(`/sys/staff?q=${encodeURIComponent(fixture.manager.name)}`);
    const counts = await api<components["schemas"]["StaffCounts"]>(
      page,
      `/staff/summary?q=${encodeURIComponent(fixture.manager.name)}`,
    );
    await expect(page.getByRole("region", { name: "员工计数", exact: true })).toContainText(
      `全部 ${counts.total}`,
    );
    await shot(page, "w206-staff-counts");
    await openStaff(page, fixture.manager.name);
    await page.getByRole("button", { name: "编辑员工", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑员工", exact: true });
    await edit.getByRole("textbox", { name: "姓名", exact: true }).fill("演练交付更新");
    const fresh = await detail(page, fixture.manager.id);
    await write(page, `/staff/${fixture.manager.id}`, "PATCH", {
      displayName: "当前版本称呼",
      lockVersion: fresh.lockVersion,
    });
    await edit.getByRole("button", { name: "核对并继续", exact: true }).click();
    const conflict = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/v1/admin/staff/${fixture.manager.id}`,
    );
    await confirm(page, "编辑员工");
    const conflicted = await conflict;
    expect(conflicted.status()).toBe(409);
    errors.allow(conflicted, `/api/v1/admin/staff/${fixture.manager.id}`);
    await expect(
      page.getByText("内容已变化，已重新读取。请打开操作并核对最新版本及在办量。", { exact: true }),
    ).toBeVisible();
    await expect(edit).toHaveCount(0);
    await page.getByRole("button", { name: "编辑员工", exact: true }).click();
    await page
      .getByRole("dialog", { name: "编辑员工", exact: true })
      .getByRole("textbox", { name: "姓名", exact: true })
      .fill("演练交付更新");
    await page
      .getByRole("dialog", { name: "编辑员工", exact: true })
      .getByRole("button", { name: "核对并继续", exact: true })
      .click();
    await confirm(page, "编辑员工");
    await expect(page.getByRole("dialog", { name: "员工详情", exact: true })).toContainText(
      "演练交付更新",
    );
    await page.getByRole("button", { name: "设置分配池", exact: true }).click();
    const pool = page.getByRole("dialog", { name: "设置分配池", exact: true });
    for (let n = original.poolMemberships.length; n > 0; n--)
      await pool.getByRole("button", { name: `移除第${n}项`, exact: true }).click();
    await pool.getByRole("button", { name: "增加分配池", exact: true }).click();
    await select(page, "分配池1", "交付经理");
    const regions = await api<{
      items: { code: string; name: string; isEnabled: boolean; ext: unknown }[];
    }>(page, "/dict-items?typeKey=region");
    const city = regions.items.find(
      (row) =>
        row.isEnabled &&
        typeof row.ext === "object" &&
        row.ext !== null &&
        "level" in row.ext &&
        row.ext.level === 2 &&
        "opened" in row.ext &&
        row.ext.opened === true &&
        "functionalZone" in row.ext &&
        row.ext.functionalZone === false,
    );
    expect(city).toBeDefined();
    await select(page, "城市1", city!.name);
    const before = await api<{ cursors: unknown[] }>(
      page,
      `/assignment-pool-members?staffId=${fixture.manager.id}`,
    );
    await shot(page, "w206-staff-pools");
    expect(
      (
        await api<{ cursors: unknown[] }>(
          page,
          `/assignment-pool-members?staffId=${fixture.manager.id}`,
        )
      ).cursors,
    ).toEqual(before.cursors);
    await pool.getByRole("button", { name: "核对并继续", exact: true }).click();
    await confirm(page, "设置分配池");
    expect(pools(await detail(page, fixture.manager.id))).toEqual([
      { pool: "delivery_manager", cityCode: city!.code },
    ]);
    expect(errors.unexpected()).toEqual([]);
  } finally {
    const current = await detail(page, fixture.manager.id);
    await write(page, `/staff/${fixture.manager.id}`, "PATCH", {
      name: original.name,
      displayName: original.displayName,
      servicePhone: original.servicePhone,
      lockVersion: current.lockVersion,
    });
    const after = await detail(page, fixture.manager.id);
    await write(page, `/staff/${fixture.manager.id}/pool-memberships`, "PUT", {
      memberships: pools(original),
      lockVersion: after.lockVersion,
    });
  }
});

test("真实在办预览、其他必填说明与禁用移交，末恢复原启用状态", async ({ page }) => {
  const fixture = w206();
  const work = await api<Work>(page, `/staff/${fixture.cs.id}/open-work`);
  expect(work.total).toBeGreaterThan(0);
  expect(work.candidates.some((row) => row.staffId === fixture.recipient.id)).toBe(true);
  try {
    await openStaff(page, fixture.cs.name);
    await page.getByRole("button", { name: "禁用员工", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "禁用员工", exact: true });
    await expect(modal).toContainText(`在办 ${work.total} 项`);
    await select(page, "移交给", fixture.recipient.name);
    await select(page, "原因", "其他");
    await expect(modal.getByRole("button", { name: "核对并继续", exact: true })).toBeDisabled();
    await modal
      .getByRole("textbox", { name: "说明（必填）", exact: true })
      .fill("W206真实浏览器移交演练");
    await modal.getByRole("button", { name: "核对并继续", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "禁用员工", exact: true });
    await expect(confirmation).toContainText(String(work.total));
    await expect(confirmation).toContainText(fixture.recipient.name);
    await expect(confirmation.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
    await shot(page, "w206-staff-handover", "禁用员工");
    await confirm(page, "禁用员工", fixture.cs.staffNo);
    expect((await detail(page, fixture.cs.id)).status).toBe("disabled");
    expect((await api<Work>(page, `/staff/${fixture.cs.id}/open-work`)).total).toBe(0);
    const received = await api<Work>(page, `/staff/${fixture.recipient.id}/open-work`);
    expect(
      received.bySource
        .flatMap((row) => row.samples)
        .some((row) => row.subjectId === fixture.followId),
    ).toBe(true);
  } finally {
    const current = await detail(page, fixture.cs.id);
    if (current.status === "disabled")
      await write(page, `/staff/${fixture.cs.id}/enable`, "POST", { activationDelivery: "manual" });
    const received = await api<Work>(page, `/staff/${fixture.recipient.id}/open-work`);
    if (received.total > 0)
      await write(page, `/staff/${fixture.recipient.id}/handover`, "POST", {
        handoverToStaffId: fixture.cs.id,
        reason: "reassigned",
        note: "恢复本轮测试前归属",
      });
  }
});

test("真实启用激活、本人改密重绑恢复码、会话吊销与客服当班，安全弹层关闭清空", async ({
  page,
  browser,
}) => {
  const fixture = w206(),
    live = liveContext();
  const original = await detail(page, fixture.editor.id);
  const csRole = await api<Role>(page, "/roles/cs");
  const own = await browser.newContext({
    baseURL: live.origin,
    viewport: { width: 1366, height: 768 },
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: clientSourceHeaders("safety"),
  });
  try {
    await openStaff(page, fixture.editor.name);
    await command(page, "启用员工");
    const activation = await closeCode(page);
    await command(page, "邀请绑定企业微信");
    await expect(page.getByRole("dialog", { name: "员工详情", exact: true })).toContainText(
      "已邀请",
    );
    const personal = await own.newPage();
    const password = "Liyoxi-2026-editor",
      changedPassword = "Liyoxi-2026-updated";
    await personal.goto("/login?redirect=%2Fdelivery%2Ftasks");
    await personal.getByRole("button", { name: "首次登录，激活账号", exact: true }).click();
    await personal.getByLabel("手机号", { exact: true }).fill(fixture.editor.phone);
    await personal.getByLabel("激活码", { exact: true }).fill(activation);
    await personal.getByLabel("新密码", { exact: true }).fill(password);
    await personal.getByRole("button", { name: "设置密码并继续", exact: true }).click();
    const firstSecret = personal.getByRole("textbox", { name: "手输密钥", exact: true });
    await expect(firstSecret).not.toHaveValue("");
    await personal
      .getByLabel("6 位动态口令", { exact: true })
      .fill(totp(await firstSecret.inputValue()));
    await personal.getByRole("button", { name: "验证并绑定", exact: true }).click();
    const initialCodes = personal.getByLabel("恢复码清单", { exact: true }).locator("code");
    await expect(initialCodes).toHaveCount(10);
    const oldCodes = await initialCodes.allTextContents();
    expect(oldCodes).toHaveLength(10);
    await personal.getByRole("checkbox", { name: "我已保存恢复码", exact: true }).check();
    await personal.getByRole("button", { name: "进入后台", exact: true }).click();
    await expect(personal.getByRole("button", { name: "用户菜单", exact: true })).toContainText(
      fixture.editor.name,
    );
    await personal.getByRole("button", { name: "用户菜单", exact: true }).click();
    await personal.getByRole("menuitem", { name: "修改密码", exact: true }).click();
    const passDialog = personal.getByRole("dialog", { name: "修改密码", exact: true });
    await passDialog.getByLabel("当前密码", { exact: true }).fill(password);
    await passDialog.getByLabel("新密码", { exact: true }).fill(changedPassword);
    await shot(personal, "w206-self-password");
    await passDialog.getByRole("button", { name: "确认修改", exact: true }).click();
    await expect(passDialog).toContainText("密码已修改，其他会话已失效。");
    await passDialog
      .locator(".lyx-confirm__footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const oldPassword = await personal.request.post("/api/v1/admin/auth/login", {
      data: { phone: fixture.editor.phone, password },
      headers: { Origin: live.origin, "X-LYX-Admin": "1" },
    });
    expect(oldPassword.status()).not.toBe(200);
    await personal.getByRole("button", { name: "用户菜单", exact: true }).click();
    await personal.getByRole("menuitem", { name: "动态口令设置", exact: true }).click();
    const mfa = personal.getByRole("dialog", { name: "动态口令设置", exact: true });
    await mfa.getByRole("button", { name: "生成新密钥", exact: true }).click();
    await expect(mfa.getByLabel("手输密钥", { exact: true })).not.toHaveValue("");
    await shot(personal, "w206-self-totp-masked");
    await mfa
      .locator(".lyx-confirm__footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await personal.getByRole("button", { name: "用户菜单", exact: true }).click();
    await personal.getByRole("menuitem", { name: "动态口令设置", exact: true }).click();
    await expect(mfa.getByLabel("手输密钥", { exact: true })).toHaveCount(0);
    await mfa.getByRole("button", { name: "生成新密钥", exact: true }).click();
    await expect(mfa.getByLabel("手输密钥", { exact: true })).not.toHaveValue("");
    await mfa
      .getByLabel("新动态口令", { exact: true })
      .fill(totp(await mfa.getByLabel("手输密钥", { exact: true }).inputValue()));
    await mfa.getByRole("button", { name: "确认绑定", exact: true }).click();
    const recovery = mfa.getByLabel("本人恢复码", { exact: true }).locator("code");
    await expect(recovery).toHaveCount(10);
    await expect(mfa.getByRole("button", { name: "已保存，关闭", exact: true })).toBeDisabled();
    await expect(mfa.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
    await expect(mfa.locator(".ant-modal-close")).toHaveCount(0);
    await personal.keyboard.press("Escape");
    await expect(mfa).toBeVisible();
    await mfa.getByRole("checkbox", { name: "我已保存恢复码", exact: true }).check();
    await mfa.getByRole("button", { name: "已保存，关闭", exact: true }).click();
    const login = await personal.request.post("/api/v1/admin/auth/login", {
      data: { phone: fixture.editor.phone, password: changedPassword },
      headers: { Origin: live.origin, "X-LYX-Admin": "1" },
    });
    expect(login.status()).toBe(200);
    const ticket = ((await login.json()) as { data: { ticket: string } }).data.ticket;
    const oldRecovery = await personal.request.post("/api/v1/admin/auth/verify-mfa", {
      data: { ticket, method: "recovery", code: oldCodes[0] },
      headers: { Origin: live.origin, "X-LYX-Admin": "1" },
    });
    expect(oldRecovery.status()).not.toBe(200);
    await personal.getByRole("button", { name: "用户菜单", exact: true }).click();
    await personal.getByRole("menuitem", { name: "动态口令设置", exact: true }).click();
    await expect(mfa.getByLabel("本人恢复码", { exact: true })).toHaveCount(0);
    await mfa
      .locator(".lyx-confirm__footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await personal.getByRole("button", { name: "用户菜单", exact: true }).click();
    await personal.getByRole("menuitem", { name: "绑定企业微信", exact: true }).click();
    const binding = personal.getByRole("dialog", { name: "绑定企业微信", exact: true });
    await binding.getByLabel("企业微信账号", { exact: true }).fill("w206-editor-self");
    await binding.getByRole("button", { name: "确认绑定", exact: true }).click();
    await expect(binding).toContainText("企业微信状态：已绑定");
    await binding
      .locator(".lyx-confirm__footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();

    // 真实角色修改使已有登录态读到新的当前身份；仅为此演练暂授客服系统查看，末尾恢复。
    await write(page, "/roles/cs", "PUT", {
      moduleLevels: { ...csRole.moduleLevels, system: "v" },
      actions: csRole.actions,
      dataScope: csRole.dataScope,
      lockVersion: csRole.lockVersion,
    });
    const current = await detail(page, fixture.editor.id);
    await write(page, `/staff/${fixture.editor.id}`, "PATCH", {
      roleKey: "cs",
      isLead: false,
      ackNoLead: true,
      lockVersion: current.lockVersion,
    });
    const changed = await detail(page, fixture.editor.id);
    await write(page, `/staff/${fixture.editor.id}/pool-memberships`, "PUT", {
      memberships: [{ pool: "cs", cityCode: null }],
      lockVersion: changed.lockVersion,
    });
    await openStaff(personal, fixture.editor.name);
    await personal.getByRole("button", { name: "结束当班", exact: true }).click();
    const duty = personal.getByRole("dialog", { name: "结束当班", exact: true });
    await duty.getByRole("checkbox", { name: "我已核对当班状态", exact: true }).check();
    await duty.getByRole("button", { name: "确认", exact: true }).click();
    await expect(personal.getByRole("button", { name: "开始当班", exact: true })).toBeVisible();

    await openStaff(page, fixture.editor.name);
    await page.getByRole("button", { name: "在线会话", exact: true }).click();
    const sessions = page.getByRole("dialog", { name: "在线会话", exact: true });
    await expect(sessions.getByRole("button", { name: "强制下线", exact: true })).toHaveCount(1);
    await shot(page, "w206-staff-sessions", "在线会话");
    await sessions.getByRole("button", { name: "强制下线", exact: true }).click();
    const revoke = page.getByRole("dialog", { name: "强制下线", exact: true });
    await revoke.getByRole("checkbox", { name: "我已核对需要吊销的会话", exact: true }).check();
    await revoke.getByRole("button", { name: "确认", exact: true }).click();
    await expect(sessions.getByRole("button", { name: "强制下线", exact: true })).toHaveCount(0);
    await personal.reload();
    await expect(personal).toHaveURL(/\/login/);
    await page.keyboard.press("Escape");
    await command(page, "重置动态口令", fixture.editor.staffNo);
    await closeCode(page);
    await command(page, "补发激活码");
    await closeCode(page);
    await command(page, "重置密码", fixture.editor.staffNo);
    await closeCode(page);
    await command(page, "解除锁定");
  } finally {
    await own.close();
    let current = await detail(page, fixture.editor.id);
    if (current.roleKey !== original.roleKey)
      await write(page, `/staff/${fixture.editor.id}`, "PATCH", {
        roleKey: original.roleKey,
        staffGroupId: original.staffGroup?.staffGroupId,
        isLead: original.isLead,
        ackNoLead: true,
        lockVersion: current.lockVersion,
      });
    current = await detail(page, fixture.editor.id);
    if (current.status === "active")
      await write(page, `/staff/${fixture.editor.id}/pool-memberships`, "PUT", {
        memberships: pools(original),
        lockVersion: current.lockVersion,
      });
    const role = await api<Role>(page, "/roles/cs");
    await write(page, "/roles/cs", "PUT", {
      moduleLevels: csRole.moduleLevels,
      actions: csRole.actions,
      dataScope: csRole.dataScope,
      lockVersion: role.lockVersion,
    });
    current = await detail(page, fixture.editor.id);
    if (current.status === "active") {
      const work = await api<Work>(page, `/staff/${fixture.editor.id}/open-work`);
      expect(work.total).toBe(0);
      await write(page, `/staff/${fixture.editor.id}/disable`, "POST", {
        reason: "other",
        note: "恢复原禁用测试员工",
        confirm: { staffNo: fixture.editor.staffNo, openWorkCount: 0 },
      });
    }
  }
});

test("员工编辑返回焦点真实刷新详情，旧草稿仍按打开版本409后重新核对", async ({ page }) => {
  const fixture = w206(),
    errors = recordExpectedConflictErrors(page);
  const original = await detail(page, fixture.manager.id);
  const path = `/api/v1/admin/staff/${fixture.manager.id}`;
  const descriptor = await page.evaluateHandle(() =>
    Object.getOwnPropertyDescriptor(document, "visibilityState"),
  );
  const background = await page.context().newPage();
  let visibilityProbe = false;
  let restoreFetch: (() => Promise<void>) | undefined;
  const restoreVisibility = async () => {
    if (visibilityProbe)
      await page.evaluate((saved) => {
        if (saved) Object.defineProperty(document, "visibilityState", saved);
        else Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      }, descriptor);
  };
  try {
    await page.bringToFront();
    await openStaff(page, fixture.manager.name);
    // Chromium未在协议事件中保留Request.clone的流式正文；旁读克隆，不改变实际fetch。
    const capture = await page.evaluateHandle((targetPath) => {
      const originalFetch = window.fetch;
      const state = {
        requests: 0,
        values: [] as { lockVersion: number; name: string; displayName: string }[],
        errors: [] as string[],
      };
      window.fetch = (input, init) => {
        if (
          input instanceof Request &&
          input.method === "PATCH" &&
          new URL(input.url).origin === location.origin &&
          new URL(input.url).pathname === targetPath
        ) {
          state.requests++;
          try {
            void input
              .clone()
              .json()
              .then(
                (body: unknown) => {
                  if (
                    typeof body === "object" &&
                    body !== null &&
                    "lockVersion" in body &&
                    typeof body.lockVersion === "number" &&
                    "name" in body &&
                    typeof body.name === "string" &&
                    "displayName" in body &&
                    typeof body.displayName === "string"
                  ) {
                    state.values.push({
                      lockVersion: body.lockVersion,
                      name: body.name,
                      displayName: body.displayName,
                    });
                  } else state.errors.push("unexpected observed field types");
                },
                () => state.errors.push("clone JSON read failed"),
              );
          } catch {
            state.errors.push("Request clone failed");
          }
        }
        return originalFetch.call(window, input, init);
      };
      return {
        state,
        restore: () => {
          window.fetch = originalFetch;
        },
      };
    }, path);
    restoreFetch = async () => {
      await capture.evaluate((value) => value.restore());
      await capture.dispose();
    };
    await page.getByRole("button", { name: "编辑员工", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑员工", exact: true });
    await edit.getByRole("textbox", { name: "姓名", exact: true }).fill("焦点旧草稿");
    await edit.getByRole("textbox", { name: "对外称呼", exact: true }).fill("旧稿称呼");
    await background.goto("about:blank");
    await background.bringToFront();
    const browserHidden = await page.evaluate(() => document.visibilityState === "hidden");
    if (!browserHidden) {
      visibilityProbe = true;
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      });
    }
    const mode = browserHidden
      ? "浏览器真实tab隐藏/恢复"
      : "headless未隐藏tab：限定visibility依赖探针，非物理切窗";
    test.info().annotations.push({ type: "w206-focus-mode", description: mode });
    await write(page, `/staff/${fixture.manager.id}`, "PATCH", {
      name: "焦点服务端",
      displayName: "服务端称呼",
      lockVersion: original.lockVersion,
    });
    const changed = await detail(page, fixture.manager.id);
    expect(changed.lockVersion).toBeGreaterThan(original.lockVersion);
    const refetch = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname === path,
    );
    await page.bringToFront();
    await restoreVisibility();
    const refreshed = await refetch;
    expect(refreshed.status()).toBe(200);
    expect(((await refreshed.json()) as { data: Detail }).data.lockVersion).toBe(
      changed.lockVersion,
    );
    // 确认查询结果已进入当前详情组件；仅收到HTTP响应不足以证明prop已刷新。
    await expect(
      page
        .getByRole("dialog", { name: "员工详情", exact: true })
        .getByText(`焦点服务端 / ${fixture.manager.staffNo}`, { exact: true }),
    ).toBeVisible();
    await expect(edit.getByRole("textbox", { name: "姓名", exact: true })).toHaveValue(
      "焦点旧草稿",
    );
    await expect(edit.getByRole("textbox", { name: "对外称呼", exact: true })).toHaveValue(
      "旧稿称呼",
    );
    await edit.getByRole("button", { name: "核对并继续", exact: true }).click();
    await expect(edit).toContainText(`${original.name} / ${fixture.manager.staffNo}`);
    const patch = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname === path,
    );
    await confirm(page, "编辑员工");
    const conflicted = await patch;
    await expect.poll(() => capture.evaluate((value) => value.state.values.length)).toBe(1);
    const captured = await capture.evaluate((value) => value.state);
    expect(captured.requests).toBe(1);
    expect(captured.errors).toEqual([]);
    const submitted = captured.values[0]!;
    expect(submitted).toMatchObject({
      lockVersion: original.lockVersion,
      name: "焦点旧草稿",
      displayName: "旧稿称呼",
    });
    expect(conflicted.status()).toBe(409);
    errors.allow(conflicted, path);
    await expect(
      page.getByText("内容已变化，已重新读取。请打开操作并核对最新版本及在办量。", { exact: true }),
    ).toBeVisible();
    expect(await detail(page, fixture.manager.id)).toMatchObject({
      name: "焦点服务端",
      displayName: "服务端称呼",
      lockVersion: changed.lockVersion,
    });
    await page.getByRole("button", { name: "编辑员工", exact: true }).click();
    await expect(edit.getByRole("textbox", { name: "姓名", exact: true })).toHaveValue(
      "焦点服务端",
    );
    await expect(edit.getByRole("textbox", { name: "对外称呼", exact: true })).toHaveValue(
      "服务端称呼",
    );
    await edit.getByRole("button", { name: "取消", exact: true }).click();
    expect(errors.unexpected()).toEqual([]);
    const info = test.info();
    await info.attach("w206-focus-version-proof", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          mode,
          openedVersion: original.lockVersion,
          refreshedVersion: changed.lockVersion,
          submittedVersion: submitted.lockVersion,
          status: conflicted.status(),
        }),
      ),
    });
  } finally {
    await restoreFetch?.();
    await restoreVisibility();
    await descriptor.dispose();
    await background.close();
    const current = await detail(page, fixture.manager.id);
    await write(page, `/staff/${fixture.manager.id}`, "PATCH", {
      name: original.name,
      displayName: original.displayName,
      lockVersion: current.lockVersion,
    });
  }
});
