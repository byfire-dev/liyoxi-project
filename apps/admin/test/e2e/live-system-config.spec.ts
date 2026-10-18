import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays, atMinuteOfDay, calendarDate } from "@liyoxi/shared/time";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";

interface Fixture {
  industry: { id: string; code: string; name: string };
  free: { id: string; code: string; name: string };
  viewer: { phone: string; password: string; recoveryCode: string };
  year: number;
  checklistCode: string;
  flagKey: string;
}
const fixture = () => (liveContext().fixtures as { fixtures: { w207: Fixture } }).fixtures.w207;
async function shot(page: Page, name: string, dialogTitle?: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  if (dialogTitle) {
    const dialog = page.getByRole("dialog", { name: dialogTitle, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveClass(/ant-zoom-(appear|enter)/);
  }
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
async function confirm(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("checkbox").check();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "确认", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
}
async function select(page: Page, label: string, title: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByTitle(title, { exact: true }).click();
}
/** 假密码/恢复码仅通过原生Node fetch送入真实认证，不进入Playwright请求trace或截图。 */
async function viewerContext(browser: Browser) {
  const origin = liveContext().origin,
    credentials = fixture().viewer;
  const headers = { "Content-Type": "application/json", "X-LYX-Admin": "1", Origin: origin };
  const login = await fetch(`${origin}/api/v1/admin/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phone: credentials.phone, password: credentials.password }),
  });
  expect(login.status).toBe(200);
  const next = ((await login.json()) as { data: { ticket: string } }).data;
  const initialCookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const verified = await fetch(`${origin}/api/v1/admin/auth/verify-mfa`, {
    method: "POST",
    headers: { ...headers, Cookie: initialCookie },
    body: JSON.stringify({
      ticket: next.ticket,
      method: "recovery",
      code: credentials.recoveryCode,
    }),
  });
  expect(verified.status).toBe(200);
  const cookies = verified.headers.getSetCookie().map((header) => {
    const pair = header.split(";")[0]!,
      split = pair.indexOf("=");
    return {
      name: pair.slice(0, split),
      value: pair.slice(split + 1),
      domain: new URL(origin).hostname,
      path: "/",
      expires: -1,
      httpOnly: /httponly/i.test(header),
      secure: /;\s*secure/i.test(header),
      sameSite: "Lax" as const,
    };
  });
  const directory = mkdtempSync(join(tmpdir(), "lyx-w207-viewer-")),
    state = join(directory, "state.json");
  try {
    writeFileSync(state, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
    return await browser.newContext({
      storageState: state,
      viewport: { width: 1366, height: 768 },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("W207 字典主从、合法新增改名启停与实际引用409", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await page.goto(`/sys/dict?type=industry&id=${f.industry.id}`);
  await expect(page.getByRole("heading", { name: "数据字典", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "引用计数", exact: true })).toContainText("1");
  await shot(page, "w207-dict-01-master-detail");
  await page.getByRole("button", { name: "停用", exact: true }).click();
  const refused = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/dict-items/${f.industry.id}`),
  );
  await confirm(page, "停用字典项");
  const refusal = await refused;
  expect(refusal.status()).toBe(409);
  expect(await refusal.json()).toMatchObject({
    error: "DICT_ITEM_IN_USE",
    details: { refCount: 1 },
  });
  await expect(
    page.getByRole("dialog", { name: "停用字典项", exact: true }).getByRole("alert"),
  ).toContainText("1 次");
  await shot(page, "w207-dict-02-in-use", "停用字典项");
  await page
    .getByRole("dialog", { name: "停用字典项", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page
    .locator(".ant-notification-notice")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "新增字典项", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增字典项", exact: true });
  await editor.getByRole("textbox", { name: "名称", exact: true }).fill("浏览器新增合法行业");
  await editor
    .getByRole("textbox", { name: "扩展属性 JSON", exact: true })
    .fill('{"open":true,"special":false,"requiredCerts":[]}');
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/dict-items"),
  );
  await editor.getByRole("button", { name: "保存字典项", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const row = (await response.json()).data;
  await expect(page).toHaveURL(new RegExp(`id=${row.dictItemId}`));
  await expect(page.getByRole("group", { name: "编码", exact: true })).toContainText(row.code);
  await page.getByRole("button", { name: "编辑名称与属性", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "编辑字典项", exact: true });
  await rename.getByRole("textbox", { name: "名称", exact: true }).fill("浏览器改名行业");
  await rename.getByRole("button", { name: "保存字典项", exact: true }).click();
  await expect(page.getByRole("group", { name: "名称", exact: true })).toContainText(
    "浏览器改名行业",
  );
  await page.getByRole("button", { name: "停用", exact: true }).click();
  await confirm(page, "停用字典项");
  await expect(page.getByRole("group", { name: "状态", exact: true })).toContainText("停用");
  await expect(page.getByRole("group", { name: "名称", exact: true })).toContainText(
    "浏览器改名行业",
  );
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await confirm(page, "启用字典项");
  await expect(page.getByRole("group", { name: "状态", exact: true })).toContainText("启用");
  await page.getByRole("searchbox", { name: "搜索字典项", exact: true }).fill("不存在的演练字典项");
  await expect(page.getByText("没有符合条件的字典项", { exact: true })).toBeVisible();
  // Chrome会为上述已逐项校验的真实409打印网络诊断；任何其他控制台或页面错误仍失败。
  expect(errors).toEqual([
    "Failed to load resource: the server responded with a status of 409 (Conflict)",
  ]);
});

test("W207 参数当前/预约/撤销、两个浏览器上下文CAS冲突与年度内置导入", async ({
  page,
  browser,
}) => {
  const f = fixture(),
    errors = recordErrors(page);
  await page.goto(`/sys/params?group=calendar&year=${f.year}`);
  const start = page.getByLabel("上班时刻", { exact: true });
  await expect(start).toHaveValue("09:00");
  await start.fill("09:05");
  const second = await browser.newContext({
    storageState: liveContext().storageState,
    viewport: { width: 1366, height: 768 },
  });
  try {
    const other = await second.newPage();
    await other.goto(`/sys/params?group=calendar&year=${f.year}`);
    await other.getByLabel("上班时刻", { exact: true }).fill("09:10");
    await other.getByRole("button", { name: "保存当前参数", exact: true }).click();
    await confirm(other, "确认保存参数");
    await expect(other.getByRole("alert")).toContainText("参数已保存");
    await page.getByRole("button", { name: "保存当前参数", exact: true }).click();
    const conflict = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" && response.url().endsWith("/param-values"),
    );
    await confirm(page, "确认保存参数");
    const conflictResponse = await conflict;
    expect(conflictResponse.status()).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({ error: "VERSION_CONFLICT" });
    await expect(page.getByRole("alert").filter({ hasText: "参数版本冲突" })).toBeVisible();
    await expect(start).toHaveValue("09:05");
    await shot(page, "w207-params-02-conflict");
    await page
      .locator(".ant-notification-notice")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.getByRole("button", { name: "我已核对最新版本，保留草稿继续", exact: true }).click();
    await page.getByRole("button", { name: "保存当前参数", exact: true }).click();
    await confirm(page, "确认保存参数");
    await expect(page.getByRole("alert").filter({ hasText: "参数已保存" })).toBeVisible();
  } finally {
    await second.close();
  }
  await start.fill("09:00");
  await select(page, "保存方式", "预约生效");
  const date = page.getByRole("textbox", { name: "生效日期（北京时间）", exact: true });
  await date.click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-picker-dropdown:visible")).toHaveCount(0);
  await date.press("Tab");
  await expect(page.getByLabel("生效时刻（北京时间）", { exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(date).toBeFocused();
  const scheduledDate = addDays(calendarDate(new Date()), 30);
  await date.fill(scheduledDate);
  await date.press("Enter");
  await page.getByLabel("生效时刻（北京时间）", { exact: true }).fill("10:00");
  await page.getByRole("button", { name: "预约参数生效", exact: true }).click();
  await confirm(page, "确认预约参数");
  await expect(
    page.getByText(`${appDateTimeFormat.dateTime(atMinuteOfDay(scheduledDate, 600))} 生效`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "参数配置", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText(/当前：09:05/)).toBeVisible();
  await expect(page.getByText("预约版本 4", { exact: true })).toBeVisible();
  await shot(page, "w207-params-01-current-pending");
  await page.getByRole("button", { name: "撤销此预约", exact: true }).click();
  await confirm(page, "撤销预约参数");
  await expect(page.getByRole("button", { name: "撤销此预约", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "导入内置年度安排", exact: true }).click();
  await confirm(page, "导入内置年度安排");
  await expect(page.getByRole("table", { name: "年度节假日安排", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "年度工作日历", exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "w207-calendar-01-imported");
  await page.getByRole("button", { name: "导入内置年度安排", exact: true }).click();
  await confirm(page, "导入内置年度安排");
  await expect(page.getByRole("alert").filter({ hasText: "导入没有变化" })).toBeVisible();
  await page.getByLabel("日历年份", { exact: true }).fill("2025");
  await page.getByRole("button", { name: "导入内置年度安排", exact: true }).click();
  const missingYear = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/calendar-days/import"),
  );
  await confirm(page, "导入内置年度安排");
  const missingResponse = await missingYear;
  expect(missingResponse.status()).toBe(400);
  expect(await missingResponse.json()).toMatchObject({
    error: "VALIDATION_FAILED",
    fieldErrors: [{ path: "days", message: expect.stringMatching(/内置|安排/) }],
  });
  await expect(
    page.getByRole("dialog", { name: "导入内置年度安排", exact: true }).getByRole("alert"),
  ).toContainText(/内置|安排/);
  expect(errors).toEqual([
    "Failed to load resource: the server responded with a status of 409 (Conflict)",
    "Failed to load resource: the server responded with a status of 400 (Bad Request)",
  ]);
});

test("W207 超级管理员有序规则、清单草稿/启用/旧版本退役/放弃与只读历史", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await page.goto(`/sys/flags?id=${f.flagKey}`);
  const editor = page.getByRole("dialog", { name: `开关 ${f.flagKey}`, exact: true });
  await expect(editor).toBeVisible();
  await editor
    .getByRole("textbox", { name: "有序规则 JSON", exact: true })
    .fill(
      '[{"when":{"envVersion":["trial"]},"value":true},{"when":{"platform":["devtools"]},"value":false}]',
    );
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await confirm(page, "确认修改开关");
  await expect(page.getByRole("alert")).toContainText("开关已保存");
  const reread = await page.request.get("/api/v1/admin/feature-flags");
  expect(reread.status()).toBe(200);
  const flag = (await reread.json()).data.items.find(
    (row: { flagKey: string }) => row.flagKey === f.flagKey,
  );
  expect(flag.rules).toHaveLength(2);
  expect(flag.rules[0].when.envVersion).toEqual(["trial"]);
  await page
    .getByRole("row")
    .filter({ hasText: f.flagKey })
    .getByRole("button", { name: "查看与编辑", exact: true })
    .click();
  await shot(page, "w207-flags-01-rules", `开关 ${f.flagKey}`);
  await page
    .getByRole("dialog", { name: `开关 ${f.flagKey}`, exact: true })
    .getByRole("form", { name: "开关编辑", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.goto(`/sys/checklists?code=${f.checklistCode}`);
  await page.getByRole("button", { name: "新建清单版本", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建清单版本", exact: true });
  await select(page, "清单编码", f.checklistCode);
  await form.getByRole("textbox", { name: "条目1名称", exact: true }).fill("浏览器真实巡检");
  await form.getByRole("button", { name: "创建草稿版本", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("新的草稿版本已建立");
  const draft = page
    .getByRole("row")
    .filter({ hasText: f.checklistCode })
    .filter({ hasText: "草稿" })
    .first();
  await draft.getByRole("button", { name: "启用", exact: true }).click();
  await shot(page, "w207-checklists-01-activate-confirm", "启用清单版本");
  await confirm(page, "启用清单版本");
  await expect(page.getByRole("row").filter({ hasText: "已退役" })).not.toHaveCount(0);
  const active = page
    .getByRole("row")
    .filter({ hasText: f.checklistCode })
    .filter({ hasText: "启用" })
    .first();
  await active.getByRole("button", { name: "查看", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("必填 · 不允许不适用 · 内部显示", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "以此创建新版本", exact: true })
    .click();
  await form.getByRole("button", { name: "创建草稿版本", exact: true }).click();
  const nextDraft = page
    .getByRole("row")
    .filter({ hasText: f.checklistCode })
    .filter({ hasText: "草稿" })
    .first();
  await nextDraft.getByRole("button", { name: "查看", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "放弃旧草稿并创建修订版本", exact: true })
    .click();
  await form.getByRole("textbox", { name: "条目1名称", exact: true }).fill("浏览器修订巡检");
  await form.getByRole("button", { name: "放弃旧草稿并创建新版本", exact: true }).click();
  await confirm(page, "确认替换草稿版本");
  await expect(nextDraft).toHaveCount(1);
  await nextDraft.getByRole("button", { name: "放弃", exact: true }).click();
  await confirm(page, "放弃清单草稿");
  await expect(page.getByRole("row").filter({ hasText: "草稿" })).toHaveCount(0);
  await page
    .getByRole("row")
    .filter({ hasText: "已退役" })
    .first()
    .getByRole("button", { name: "查看", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("W207 普通查看者三页只读、开关路由及写API真实拒绝，合法空筛选", async ({ browser }) => {
  const context = await viewerContext(browser),
    page = await context.newPage(),
    errors = recordErrors(page);
  try {
    await page.goto("/sys/params?group=calendar&year=2026");
    await expect(page.getByLabel("上班时刻", { exact: true })).toBeDisabled();
    await expect(page.getByText("当前配置为只读", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "开关管理", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "导入内置年度安排", exact: true })).toHaveCount(
      0,
    );
    await page.goto("/sys/dict?type=industry");
    await expect(page.getByRole("button", { name: "新增字典项", exact: true })).toHaveCount(0);
    await page.goto("/sys/checklists?q=不存在的演练清单");
    await expect(page.getByText("没有符合条件的记录", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建清单版本", exact: true })).toHaveCount(0);
    await page.goto("/sys/flags");
    await expect(page).toHaveURL(/\/403/);
    const refused = await page.request.put("/api/v1/admin/param-values", {
      data: { items: [{ key: "work.start", value: "10:00", expectedRev: null }] },
      headers: {
        "Idempotency-Key": `w207-denied:${crypto.randomUUID()}`,
        "X-LYX-Admin": "1",
        Origin: liveContext().origin,
      },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toBe("PERMISSION_DENIED");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
