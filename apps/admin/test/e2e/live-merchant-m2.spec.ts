import { mkdirSync } from "node:fs";
import {
  EntityCardSchema,
  AccountChangeRequestDetailSchema,
  StoreHeaderSchema,
} from "@liyoxi/contract";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { totp } from "./w206-helpers";
interface Fixture {
  store: { storeId: string; name: string; entityId: string; primaryStoreId: string };
  otherStoreId: string;
  previousManager: { staffId: string; name: string };
  owner: { merchantUserId: string; phoneMask: string | null };
  clerk: {
    merchantUserId: string;
    memberId: string;
    phoneMask: string | null;
    name: string | null;
  };
}
const fixtures = () =>
  (
    liveContext().fixtures as {
      fixtures: {
        "merchant-m2": Fixture;
        w308: {
          viewer: {
            phone: string;
            password: string;
            totpSecret: string;
            totpLastStep: number | null;
          };
        };
      };
    }
  ).fixtures;
const fixture = () => fixtures()["merchant-m2"];
const row = (page: Page, id: string) => page.locator(`tr[data-row-key="${id}"]`);
const wait = (page: Page, method: string, path: string) =>
  page.waitForResponse(
    (r) => r.request().method() === method && new URL(r.url()).pathname === `/api/v1/admin/${path}`,
  );
async function get(page: Page, path: string) {
  const r = await page.request.get(`/api/v1/admin/${path}`);
  expect(r.status()).toBe(200);
  return (await r.json()).data;
}
async function post(page: Page, path: string, body: unknown) {
  return page.request.post(`/api/v1/admin/${path}`, {
    headers: {
      Origin: liveContext().origin,
      "X-LYX-Admin": "1",
      "Idempotency-Key": `w215:${crypto.randomUUID()}`,
    },
    data: body,
  });
}
async function confirm(page: Page, title: string) {
  await page.getByRole("button", { name: "继续确认", exact: true }).click();
  const modal = page.getByRole("dialog", { name: title, exact: true });
  const button = modal.getByRole("button", { name: "确认操作", exact: true });
  await expect(button).toBeDisabled();
  await modal.getByRole("checkbox", { name: "我已核对当前对象、信息和操作" }).check();
  await expect(button).toBeEnabled();
  return button;
}
async function select(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
}
type Wire = { path: string; method: string; body: string; key: string | null };
async function observe(page: Page, paths: string[]) {
  await page.evaluate(
    (allowed) => {
      const native = globalThis.fetch,
        records: Wire[] = [],
        pending: Promise<void>[] = [];
      let overflow = false;
      (globalThis as typeof globalThis & { __w215Wire(): Promise<Wire[]> }).__w215Wire =
        async () => {
          await Promise.all(pending);
          if (overflow) throw new Error("商家写观察超界");
          return records;
        };
      globalThis.fetch = (input, init) => {
        if (
          !(input instanceof Request) ||
          !["POST", "PATCH"].includes(input.method) ||
          !allowed.includes(new URL(input.url).pathname)
        )
          return native(input, init);
        if (pending.length >= 8) {
          overflow = true;
          return native(input, init);
        }
        const copy = input.clone(),
          path = new URL(input.url).pathname,
          method = input.method,
          key = input.headers.get("Idempotency-Key");
        const result = native(input, init);
        pending.push(
          copy
            .text()
            .then((body) => {
              records.push({ path, method, body, key });
            })
            .catch(() => {
              overflow = true;
            }),
        );
        return result;
      };
    },
    paths.map((p) => `/api/v1/admin/${p}`),
  );
}
async function wire(page: Page, path: string, body: object) {
  const records = (
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __w215Wire(): Promise<Wire[]> }).__w215Wire(),
    )
  ).filter((r) => r.path === `/api/v1/admin/${path}`);
  expect(records).toHaveLength(1);
  expect(JSON.parse(records[0]!.body)).toEqual(body);
  expect(records[0]!.key).toMatch(/^[A-Za-z0-9:_-]{1,128}$/);
}
async function readonlyContext(browser: Browser) {
  const live = liveContext(),
    credentials = fixtures().w308.viewer;
  if (
    credentials.totpLastStep !== null &&
    Math.floor(Date.now() / 30_000) <= credentials.totpLastStep
  )
    await new Promise((resolve) =>
      setTimeout(resolve, (credentials.totpLastStep! + 1) * 30_000 - Date.now() + 250),
    );
  const source = { "X-Forwarded-For": "198.51.100.215" },
    headers = {
      ...source,
      Origin: live.origin,
      "X-LYX-Admin": "1",
      "Content-Type": "application/json",
      "User-Agent": "lyxtest W215 readonly",
    };
  // 合成本轮凭据只在Node认证，不进入浏览器trace/截图，也不消费旧恢复码。
  const login = await fetch(`${live.origin}/api/v1/admin/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phone: credentials.phone, password: credentials.password }),
  });
  expect(login.status).toBe(200);
  const next = (await login.json()).data;
  const verified = await fetch(`${live.origin}/api/v1/admin/auth/verify-mfa`, {
    method: "POST",
    headers: {
      ...headers,
      Cookie: login.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    },
    body: JSON.stringify({
      ticket: next.ticket,
      method: "totp",
      code: totp(credentials.totpSecret),
    }),
  });
  expect(verified.status).toBe(200);
  const cookies = verified.headers.getSetCookie().map((header) => {
    const pair = header.split(";")[0]!,
      at = pair.indexOf("=");
    return {
      name: pair.slice(0, at),
      value: pair.slice(at + 1),
      domain: new URL(live.origin).hostname,
      path: "/",
      expires: -1,
      httpOnly: /httponly/i.test(header),
      secure: /;\s*secure/i.test(header),
      sameSite: "Lax" as const,
    };
  });
  return browser.newContext({
    baseURL: live.origin,
    storageState: { cookies, origins: [] },
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: "lyxtest W215 readonly",
    extraHTTPHeaders: source,
  });
}

test("W215 多店筛选同范围汇总、非首店额度与经理转移真实回显、成员边界", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await page.goto(`/merchants?q=${encodeURIComponent(f.store.name)}&pageSize=10`);
  await expect(row(page, f.store.storeId)).toContainText(f.store.name);
  await expect(page.getByRole("region", { name: "商家汇总" })).toContainText("可见门店 1");
  await row(page, f.store.storeId).getByRole("link", { name: f.store.name }).click();
  await expect(page).toHaveURL(new RegExp(`/merchants/${f.store.storeId}`));
  await expect(page.getByRole("heading", { name: f.store.name, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "主体与成员" }).click();
  await expect(page.getByText(f.clerk.phoneMask!, { exact: true })).toBeVisible();
  const before = EntityCardSchema.parse(await get(page, `entities/${f.store.entityId}`));
  const quotaPath = `entities/${f.store.entityId}/quota`;
  await observe(page, [quotaPath]);
  await page.getByRole("button", { name: "调整主体额度", exact: true }).click();
  await page.getByLabel("门店上限覆盖（空白恢复套餐）").fill("3");
  await page.getByLabel("成员上限覆盖（空白恢复套餐）").fill("6");
  await page.getByLabel("原因（必填）", { exact: true }).fill("W215真实多店额度核对");
  const quota = wait(page, "PATCH", quotaPath);
  await (await confirm(page, "调整主体额度")).click();
  expect((await quota).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await wire(page, quotaPath, {
    storeLimitOverride: 3,
    memberLimitOverride: 6,
    lockVersion: before.lockVersion,
    confirm: {
      storeLimitOverride: before.usage.storeLimitOverride,
      memberLimitOverride: before.usage.memberLimitOverride,
    },
    reasonText: "W215真实多店额度核对",
  });
  const after = EntityCardSchema.parse(await get(page, `entities/${f.store.entityId}`));
  expect(after.usage).toMatchObject({ storeLimitOverride: 3, memberLimitOverride: 6 });
  await page.getByRole("tab", { name: "负责人和跟进" }).click();
  await expect(page.getByText(f.previousManager.name, { exact: true })).toBeVisible();
  const transferPath = `stores/${f.store.storeId}/reassign-delivery-manager`;
  await observe(page, [transferPath]);
  await page.getByRole("button", { name: "转移交付经理", exact: true }).click();
  await page.getByLabel("新交付经理", { exact: true }).click();
  await page.getByRole("option", { name: /演练交付 · 工号/ }).click();
  await select(page, "转移原因", "工作量调整");
  await page.getByLabel("备注（选填）", { exact: true }).fill("W215仅转移当前非首店");
  const transfer = wait(page, "POST", transferPath);
  await (await confirm(page, "转移交付经理")).click();
  const transferResponse = await transfer;
  expect(transferResponse.status()).toBe(200);
  const moved = (await transferResponse.json()).data;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await wire(page, transferPath, {
    toStaffId: moved.deliveryManager.staffId,
    reasonCode: "workload",
    note: "W215仅转移当前非首店",
    confirm: { fromStaffId: f.previousManager.staffId },
  });
  expect(
    StoreHeaderSchema.parse(await get(page, `stores/${f.store.storeId}`)).deliveryManager?.staffId,
  ).toBe(moved.deliveryManager.staffId);
  expect(
    StoreHeaderSchema.parse(await get(page, `stores/${f.store.primaryStoreId}`)).deliveryManager,
  ).toBeNull();
  expect(
    StoreHeaderSchema.parse(await get(page, `stores/${f.otherStoreId}`)).entity.entityId,
  ).not.toBe(f.store.entityId);
  await shot(page, "merchant-m2-01-detail-follow");
  expect(errors).toEqual([]);
});

test("W215 账号申请撤回与渠道停启走真实公口，只读员工无写入口且GET零写", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const f = fixture(),
    errors = recordErrors(page);
  await page.goto(`/merchants/${f.store.storeId}?tab=accounts`);
  const members = (await get(page, `entities/${f.store.entityId}/members`)).items;
  const owner = members.find(
    (m: { user: { merchantUserId: string } }) => m.user.merchantUserId === f.owner.merchantUserId,
  );
  const reasons = (await get(page, "dict-items?typeKey=account_change_reason")).items;
  expect(reasons.length).toBeGreaterThan(0);
  await select(page, "账号变更目标", `${owner.user.displayName} · ${owner.user.phoneMask}`);
  await page.getByRole("button", { name: "申请重认证放行", exact: true }).click();
  await select(page, "申请原因", reasons[0].name);
  await page.getByLabel("申请说明（必填）").fill("W215已核对虚构主体与老板身份");
  await page.getByLabel("核验方式").fill("虚构电话核验");
  await page.getByLabel("核验记录").fill("隔离演练身份信息核对一致");
  const create = wait(page, "POST", "account-change-requests");
  await (await confirm(page, "申请重认证放行")).click();
  const createdResponse = await create;
  expect(createdResponse.status()).toBe(200);
  const created = (await createdResponse.json()).data;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row(page, created.accountChangeRequestId).click();
  const detail = AccountChangeRequestDetailSchema.parse(
    await get(page, `account-change-requests/${created.accountChangeRequestId}`),
  );
  expect(detail.approval.status).toBe("pending");
  expect(detail.actions).not.toContain("approve");
  await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  await page.getByLabel("备注（选填）").fill("W215申请人撤回核对");
  const withdraw = wait(
    page,
    "POST",
    `account-change-requests/${created.accountChangeRequestId}/withdraw`,
  );
  await (await confirm(page, "撤回账号变更")).click();
  expect((await withdraw).status()).toBe(200);
  expect(
    AccountChangeRequestDetailSchema.parse(
      await get(page, `account-change-requests/${created.accountChangeRequestId}`),
    ).approval.status,
  ).toBe("withdrawn");
  await page.goto("/merchants/referral-codes");
  await expect(page.getByRole("heading", { name: "渠道码", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "登记渠道码", exact: true }).click();
  await page.getByLabel("渠道码", { exact: true }).fill("W215LIVE");
  await page.getByLabel("说明（选填）", { exact: true }).fill("W215真实来源登记");
  const createdCode = wait(page, "POST", "referral-codes");
  await page.getByRole("button", { name: "登记", exact: true }).click();
  const codeResponse = await createdCode;
  expect(codeResponse.status()).toBe(200);
  const code = (await codeResponse.json()).data;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const [label, kind, state] of [
    ["停用", "disable", "disabled"],
    ["启用", "enable", "active"],
  ] as const) {
    await row(page, code.referralCodeId).getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${label}渠道码` });
    await dialog.getByRole("checkbox", { name: "我已核对渠道码与操作" }).check();
    const result = wait(page, "POST", `referral-codes/${code.referralCodeId}/${kind}`);
    await dialog.getByRole("button", { name: "确认操作", exact: true }).click();
    expect((await result).status()).toBe(200);
    expect((await get(page, "referral-codes?q=W215LIVE")).items[0].status).toBe(state);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await shot(page, "merchant-m2-02-referral-codes");
  const context = await readonlyContext(browser),
    view = await context.newPage();
  try {
    const writes: string[] = [];
    view.on("request", (r) => {
      if (
        new URL(r.url()).pathname.startsWith("/api/v1/admin/") &&
        !["GET", "HEAD"].includes(r.method())
      )
        writes.push(r.url());
    });
    await view.goto(`/merchants/${f.store.storeId}?tab=entity`);
    await expect(view.getByText(f.clerk.phoneMask!, { exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "调整主体额度", exact: true })).toHaveCount(0);
    await expect(view.getByRole("button", { name: "关闭主体", exact: true })).toHaveCount(0);
    await expect(view.getByRole("button", { name: "禁用", exact: true })).toHaveCount(0);
    await view.getByRole("tab", { name: "账号变更" }).click();
    await expect(view.getByRole("button", { name: "申请手机号改绑", exact: true })).toHaveCount(0);
    await view.goto("/merchants/referral-codes");
    await expect(view.getByRole("heading", { name: "渠道码", exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "登记渠道码", exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(
      (
        await post(view, `merchant-users/${f.clerk.merchantUserId}/disable`, {
          reasonText: "虚构只读拒绝",
          confirm: { phoneMask: f.clerk.phoneMask },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});
