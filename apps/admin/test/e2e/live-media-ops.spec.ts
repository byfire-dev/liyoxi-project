import { mkdirSync } from "node:fs";
import { AdminFilePageSchema, MediaJobPageSchema, PurgeRunPageSchema } from "@liyoxi/contract";
import { expect, test, type Browser, type Page, type Response } from "@playwright/test";
import { liveContext, noHorizontalScroll } from "./live-context";
import { totp } from "./w206-helpers";

interface Fixture {
  runs: {
    label: "approve" | "reject" | "conflict";
    purgeRunId: string;
    fileId: string;
    originalName: string;
  }[];
  deleted: { label: "available" | "expired"; fileId: string; originalName: string }[];
  job: { mediaJobId: string; fileId: string };
  viewer: {
    staffId: string;
    phone: string;
    password: string;
    totpSecret: string;
    totpLastStep: number | null;
  };
}
const fixture = () => (liveContext().fixtures as { fixtures: { w308: Fixture } }).fixtures.w308;
const row = (page: Page, id: string) => page.locator(`tr[data-row-key="${id}"]`);
const headers = () => ({ Origin: liveContext().origin, "X-LYX-Admin": "1" });
const response = (page: Page, path: string) =>
  page.waitForResponse(
    (result) =>
      result.request().method() === "POST" &&
      new URL(result.url()).pathname === `/api/v1/admin/${path}`,
  );
async function post(page: Page, path: string, body: unknown) {
  return page.request.post(`/api/v1/admin/${path}`, {
    headers: { ...headers(), "Idempotency-Key": `w308:${crypto.randomUUID()}` },
    data: body,
  });
}
async function runs(page: Page) {
  const result = await page.request.get("/api/v1/admin/purge-runs?page=1&pageSize=50");
  expect(result.status()).toBe(200);
  return PurgeRunPageSchema.parse((await result.json()).data).items;
}
async function files(page: Page, ids: string[]) {
  const result = await page.request.get(
    `/api/v1/admin/files?fileIds=${ids.join(",")}&page=1&pageSize=50`,
  );
  expect(result.status()).toBe(200);
  return AdminFilePageSchema.parse((await result.json()).data).items;
}
async function jobs(page: Page, fileId: string, state = "failed,queued") {
  const result = await page.request.get(
    `/api/v1/admin/media-jobs?state=${state}&subjectType=file_object&subjectId=${fileId}&page=1&pageSize=20`,
  );
  expect(result.status()).toBe(200);
  return MediaJobPageSchema.parse((await result.json()).data).items;
}
async function confirm(page: Page, title: string, fileId?: string) {
  await page.getByRole("button", { name: "继续确认", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const button = dialog.getByRole("button", { name: "确认操作", exact: true });
  await expect(button).toBeDisabled();
  if (fileId) await dialog.getByLabel("请再次输入完整文件 ID").fill(fileId);
  await dialog.getByRole("checkbox", { name: "我已核对目标与操作影响" }).check();
  await expect(button).toBeEnabled();
  return button;
}
function assertWire(result: Response, body: object) {
  expect(result.request().postDataJSON()).toEqual(body);
  expect(result.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9:_-]{1,128}$/);
}
function consoleEvidence(page: Page) {
  const errors: { text: string; url?: string }[] = [],
    expected = new Map<string, number>();
  page.on("pageerror", (error) => errors.push({ text: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push({ text: message.text(), url: message.location().url });
  });
  return {
    allow(result: Response, status: 409 | 503) {
      expect(result.status()).toBe(status);
      expected.set(result.url(), status);
    },
    assert() {
      expect(
        errors.filter((error) => {
          const status = error.url ? expected.get(error.url) : undefined;
          return (
            status === undefined ||
            error.text !==
              `Failed to load resource: the server responded with a status of ${status} (${status === 409 ? "Conflict" : "Service Unavailable"})`
          );
        }),
      ).toEqual([]);
    },
  };
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
}
/** 本轮合成凭据只经Node原生fetch认证，不进入Playwright请求trace或截图。 */
async function readonlyContext(browser: Browser) {
  const live = liveContext(),
    credentials = fixture().viewer;
  if (
    credentials.totpLastStep !== null &&
    Math.floor(Date.now() / 30_000) <= credentials.totpLastStep
  )
    await new Promise((resolve) =>
      setTimeout(resolve, (credentials.totpLastStep! + 1) * 30_000 - Date.now() + 250),
    );
  const source = { "X-Forwarded-For": "198.51.100.238" },
    authHeaders = {
      ...source,
      ...headers(),
      "Content-Type": "application/json",
      "User-Agent": "lyxtest W308 readonly",
    };
  const login = await fetch(`${live.origin}/api/v1/admin/auth/login`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ phone: credentials.phone, password: credentials.password }),
  });
  expect(login.status).toBe(200);
  const next = (await login.json()).data;
  const verified = await fetch(`${live.origin}/api/v1/admin/auth/verify-mfa`, {
    method: "POST",
    headers: {
      ...authHeaders,
      Cookie: login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
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
    userAgent: "lyxtest W308 readonly",
    extraHTTPHeaders: source,
  });
}

test("W308 清除运行真实候选联动、错回显409、放行仅approved与驳回及迟到冲突刷新", async ({
  page,
}) => {
  const f = fixture(),
    errors = consoleEvidence(page);
  const approved = f.runs.find((item) => item.label === "approve")!,
    rejected = f.runs.find((item) => item.label === "reject")!,
    conflict = f.runs.find((item) => item.label === "conflict")!;
  await page.goto("/sys/file-purges");
  await expect(row(page, rejected.purgeRunId)).toContainText("已熔断");
  await row(page, rejected.purgeRunId).click();
  await expect(page).toHaveURL(new RegExp(`purgeRunId=${rejected.purgeRunId}`));
  await expect(
    page.getByLabel("候选文件列表").locator(`tr[data-row-key="${rejected.fileId}"]`),
  ).toContainText(rejected.originalName);
  await shot(page, "media-ops-01-held-candidates");
  const before = await files(page, [conflict.fileId]);
  const mismatch = await post(page, `purge-runs/${conflict.purgeRunId}/approve`, {
    confirm: { candidateCount: 2, candidateBytes: "8" },
  });
  expect(mismatch.status()).toBe(409);
  expect((await mismatch.json()).error).toBe("CONFIRM_MISMATCH");
  expect((await runs(page)).find((item) => item.purgeRunId === conflict.purgeRunId)?.state).toBe(
    "proposed",
  );
  expect(await files(page, [conflict.fileId])).toEqual(before);

  await row(page, approved.purgeRunId).getByRole("button", { name: "放行", exact: true }).click();
  await page.getByLabel("备注（可选）").fill("隔离验收放行本次候选清单");
  const approveButton = await confirm(page, "放行"),
    approvedResponse = response(page, `purge-runs/${approved.purgeRunId}/approve`);
  await approveButton.click();
  const approvedResult = await approvedResponse;
  expect(approvedResult.status()).toBe(200);
  assertWire(approvedResult, {
    confirm: { candidateCount: 1, candidateBytes: "8" },
    note: "隔离验收放行本次候选清单",
  });
  expect((await approvedResult.json()).data).toMatchObject({
    state: "approved",
    deletedCount: null,
    startedAt: null,
    finishedAt: null,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await runs(page)).find((item) => item.purgeRunId === approved.purgeRunId)?.state).toBe(
    "approved",
  );
  expect((await files(page, [approved.fileId]))[0]).toMatchObject({
    status: "stored",
    deletedAt: null,
    erasedAt: null,
  });

  await row(page, rejected.purgeRunId).getByRole("button", { name: "驳回", exact: true }).click();
  await page.getByLabel("原因（必填）").fill("隔离验收驳回候选清单");
  const rejectButton = await confirm(page, "驳回"),
    rejectedResponse = response(page, `purge-runs/${rejected.purgeRunId}/reject`);
  await rejectButton.click();
  const rejectedResult = await rejectedResponse;
  expect(rejectedResult.status()).toBe(200);
  assertWire(rejectedResult, { reason: "隔离验收驳回候选清单" });
  expect((await rejectedResult.json()).data.state).toBe("rejected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await files(page, [rejected.fileId]))[0]).toMatchObject({
    status: "stored",
    erasedAt: null,
  });

  await row(page, conflict.purgeRunId).getByRole("button", { name: "放行", exact: true }).click();
  const staleButton = await confirm(page, "放行");
  const changed = await post(page, `purge-runs/${conflict.purgeRunId}/reject`, {
    reason: "另一个窗口已驳回此候选清单",
  });
  expect(changed.status()).toBe(200);
  const conflictResponse = response(page, `purge-runs/${conflict.purgeRunId}/approve`);
  await staleButton.click();
  const stale = await conflictResponse;
  errors.allow(stale, 409);
  expect((await stale.json()).error).toBe("STATE_NOT_ALLOWED");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("当前事实已变化，列表已刷新，请重新核对后操作", { exact: true }),
  ).toBeVisible();
  expect((await runs(page)).find((item) => item.purgeRunId === conflict.purgeRunId)?.state).toBe(
    "rejected",
  );
  errors.assert();
});

test("W308 版本IO未支持保持真实503与窗口守卫，failed任务真实重试queued、只读员工无危险动作", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const f = fixture(),
    errors = consoleEvidence(page),
    available = f.deleted.find((item) => item.label === "available")!,
    expired = f.deleted.find((item) => item.label === "expired")!;
  await page.goto("/sys/file-purges?tab=files&q=W308-");
  await expect(row(page, available.fileId)).toContainText("已清除");
  await expect(
    row(page, expired.fileId).getByRole("button", { name: "恢复", exact: true }),
  ).toHaveCount(0);
  const closed = await post(page, `files/${expired.fileId}/restore`, {
    reason: "隔离验收超出窗口拒绝恢复",
  });
  expect(closed.status()).toBe(409);
  expect((await closed.json()).error).toBe("FILE_RESTORE_WINDOW_PASSED");
  const original = await files(page, [available.fileId, expired.fileId]);
  for (const [action, title] of [
    ["restore", "恢复"],
    ["erase", "彻底删除"],
  ] as const) {
    await row(page, available.fileId).getByRole("button", { name: title, exact: true }).click();
    await page.getByLabel("原因（必填）").fill("隔离验收未支持版本操作保持原事实");
    const button = await confirm(page, title, action === "erase" ? available.fileId : undefined),
      pending = response(page, `files/${available.fileId}/${action}`);
    await button.click();
    const result = await pending;
    errors.allow(result, 503);
    expect((await result.json()).error).toBe("PROVIDER_UNAVAILABLE");
    await expect(page.getByRole("dialog", { name: title, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await files(page, [available.fileId, expired.fileId])).toEqual(original);
  }
  await page.goto(`/sys/flow-ops?tab=media&subjectType=file_object&subjectId=${f.job.fileId}`);
  await expect(page.getByRole("tab", { name: "媒体任务", exact: true })).toBeVisible();
  await expect(row(page, f.job.mediaJobId)).toContainText("CI_IMAGE_UNAVAILABLE");
  expect(await page.content()).not.toContain("W308_PRIVATE_UPSTREAM_DETAIL");
  await shot(page, "media-ops-02-failed-job");
  await row(page, f.job.mediaJobId).getByRole("button", { name: "重试任务", exact: true }).click();
  await page.getByLabel("备注（可选）").fill("隔离验收重试真实媒体任务");
  const retryButton = await confirm(page, "重试任务"),
    pending = response(page, `media-jobs/${f.job.mediaJobId}/retry`);
  await retryButton.click();
  const retried = await pending;
  expect(retried.status()).toBe(200);
  assertWire(retried, { note: "隔离验收重试真实媒体任务" });
  expect((await retried.json()).data).toMatchObject({
    mediaJobId: f.job.mediaJobId,
    state: "queued",
    attemptNo: 0,
    error: null,
    finishedAt: null,
  });
  await expect(row(page, f.job.mediaJobId)).toHaveCount(0);
  expect(
    (await jobs(page, f.job.fileId)).find((item) => item.mediaJobId === f.job.mediaJobId),
  ).toMatchObject({ state: "queued", attemptNo: 0, error: null, finishedAt: null });
  expect((await files(page, [f.job.fileId]))[0]).toMatchObject({
    status: "stored",
    moderationState: "pending",
  });

  const context = await readonlyContext(browser);
  try {
    const viewer = await context.newPage(),
      viewerErrors = consoleEvidence(viewer);
    await viewer.goto("/sys/file-purges");
    await expect(viewer.getByRole("heading", { name: "文件清除放行", exact: true })).toBeVisible();
    const me = await viewer.request.get("/api/v1/admin/auth/me");
    expect(me.status()).toBe(200);
    expect((await me.json()).data).toMatchObject({
      staff: { staffId: f.viewer.staffId },
      moduleLevels: { system: "v" },
    });
    for (const title of ["放行", "驳回", "恢复", "彻底删除"])
      await expect(viewer.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    await viewer.goto(`/sys/file-purges?tab=files&q=W308-`);
    for (const title of ["恢复", "彻底删除"])
      await expect(viewer.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    await viewer.goto(
      `/sys/flow-ops?tab=media&subjectType=file_object&subjectId=${f.job.fileId}&state=failed,queued`,
    );
    await expect(row(viewer, f.job.mediaJobId)).toBeVisible();
    await expect(viewer.getByRole("button", { name: "重试任务", exact: true })).toHaveCount(0);
    for (const [path, body] of [
      [
        `purge-runs/${f.runs[0]!.purgeRunId}/approve`,
        { confirm: { candidateCount: 1, candidateBytes: "8" } },
      ],
      [`purge-runs/${f.runs[0]!.purgeRunId}/reject`, { reason: "只读员工不能决定候选清单" }],
      [`files/${available.fileId}/restore`, { reason: "只读员工不能恢复文件" }],
      [
        `files/${available.fileId}/erase`,
        {
          reason: "只读员工不能彻底删除文件",
          confirm: { fileId: available.fileId, category: "poster" },
        },
      ],
      [`media-jobs/${f.job.mediaJobId}/retry`, {}],
    ] as const) {
      const denied = await post(viewer, path, body);
      expect(denied.status()).toBe(403);
      expect((await denied.json()).error).toBe("PERMISSION_DENIED");
    }
    expect(await files(page, [available.fileId, expired.fileId])).toEqual(original);
    expect((await jobs(page, f.job.fileId))[0]?.state).toBe("queued");
    viewerErrors.assert();
  } finally {
    await context.close();
  }
  errors.assert();
});
