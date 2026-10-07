import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { operations } from "@liyoxi/contract/types/merchant";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
type ResponseOf<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer T } } } };
}
  ? T
  : never;
interface Fixture {
  items: {
    ticketId: string;
    itemId: string;
    name: string;
    title: string;
    outcome: string;
    headers: Record<string, string>;
    sampleId: string;
    mediaFileIds: string[];
  }[];
  mediaFileIds: string[];
  runId: string;
  facts: { sizeBytes: number; sha256: string };
  unknownMetadataRejectedWithoutWrites: boolean;
}
function fixture() {
  return (liveContext().fixtures as { fixtures: { w120: Fixture } }).fixtures.w120;
}
test.afterEach(({ page: _page }, info) => {
  const own = fixture();
  const item = own.items.find(
    (row) => row.outcome === (info.title.includes("通过链") ? "pass" : "reject"),
  );
  if (!item) throw new Error("W120 清理范围缺失");
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@liyoxi/services",
      "exec",
      "tsx",
      "src/testing/admin-live/w120-media.ts",
      "--cleanup-run",
      own.runId,
      ...item.mediaFileIds,
    ],
    {
      cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
      env: Object.fromEntries(
        ["PATH", "HOME", "USER", "TMPDIR"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]]],
        ),
      ),
      stdio: "pipe",
    },
  );
});
async function data<T>(response: APIResponse): Promise<T> {
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as T;
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (name.endsWith("delivery-after"))
    await page.getByText("下载链接有效期", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `dist/e2e-shots/w120-${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
async function push(page: Page, item: Fixture["items"][number]) {
  await page.goto(`/publish/deliveries?q=交付核验演练&id=${item.ticketId}`);
  await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "成片剧集 · 2/2 集质检通过", exact: true }),
  ).toBeVisible();
  const button = page.getByRole("button", { name: "推送给商家", exact: true });
  await expect(button).toBeDisabled();
  await shot(page, `${item.outcome}-delivery-before`);
  for (const check of await page.getByRole("checkbox").all()) await check.check();
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/${item.ticketId}/push-package`))
      writes++;
  });
  const detailPath = `**/api/v1/admin/delivery-tickets/${item.ticketId}`;
  let resume: (() => void) | undefined;
  let captured!: () => void;
  const paused = new Promise<void>((resolve) => {
    captured = resolve;
  });
  if (item.outcome === "pass")
    await page.route(detailPath, async (route) => {
      const response = await route.fetch(); // 只延迟真实 GET，POST 与响应内容均由实际服务产生。
      await new Promise<void>((resolve) => {
        resume = resolve;
        captured();
      });
      await route.fulfill({ response });
    });
  await button.evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  if (item.outcome === "pass") {
    await paused;
    const next = fixture().items.find((row) => row.outcome === "reject");
    if (!next || !resume) throw new Error("W120 旧响应验证范围缺失");
    await page.getByRole("button", { name: new RegExp(next.name) }).click();
    await expect(page.getByRole("heading", { name: next.title, exact: true })).toBeVisible();
    const late = page.waitForResponse((response) => response.url().includes("/delivery-releases/"));
    resume();
    await late;
    await expect(page.getByRole("heading", { name: next.title, exact: true })).toBeVisible();
    await expect(page.getByText("下载链接有效期", { exact: true })).toHaveCount(0);
    await page.unroute(detailPath);
    await page.goto(`/publish/deliveries?tab=delivered_today&q=${item.name}&id=${item.ticketId}`);
  }
  await expect(page.getByText("下载链接有效期", { exact: true })).toBeVisible();
  await expect.poll(() => writes).toBe(1);
  await shot(page, `${item.outcome}-delivery-after`);
  const release = await data<ResponseOf<"m.orderItem.release.get">>(
    await page.request.get(`/api/v1/m/order-items/${item.itemId}/release`, {
      headers: item.headers,
    }),
  );
  expect(release).toMatchObject({ episodeCount: 2, state: "pushed", isDownloadable: true });
  expect(release.grant?.expiresAt).toBeTruthy();
  const url = await data<ResponseOf<"m.orderItem.downloadUrls">>(
    await page.request.post(`/api/v1/m/order-items/${item.itemId}/download-urls`, {
      headers: item.headers,
      data: { kind: "episode", episodeNo: 2 },
    }),
  );
  expect(new URL(url.url).origin).toBe("http://127.0.0.1:9100");
  const physical = await page.request.get(url.url);
  expect(physical.status()).toBe(200);
  expect((await physical.body()).length).toBe(fixture().facts.sizeBytes);
  const list = await data<ResponseOf<"m.launchTask.list">>(
    await page.request.get(`/api/v1/m/launch-tasks?orderItemId=${item.itemId}`, {
      headers: item.headers,
    }),
  );
  const task = list.items[0]?.items[0]?.tasks[0];
  if (!task) throw new Error("真实发布任务缺失");
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  await data(
    await page.request.post(`/api/v1/m/launch-tasks/${task.launchTaskId}/submit`, {
      headers: { ...item.headers, "Idempotency-Key": `w120-submit:${task.launchTaskId}` },
      data: {
        linkKind: "collection",
        collectionUrl: `https://www.douyin.com/collection/${item.outcome === "pass" ? "712345678901" : "712345678902"}`,
        reportedEpisodeCount: 2,
        actualLaunchDate: today,
      },
    }),
  );
  return task.launchTaskId;
}
test("真实交付通过链：物理成片、下载授权、商家回填、清单通过到服务中", async ({ page }) => {
  const errors = recordErrors(page),
    source = fixture(),
    item = source.items.find((row) => row.outcome === "pass");
  if (!item) throw new Error("W120 通过链缺失");
  expect(source.unknownMetadataRejectedWithoutWrites).toBe(true);
  const taskId = await push(page, item);
  await page.goto(`/publish/verify?q=${item.name}`);
  await expect(page.getByRole("heading", { name: "商家提交链接", exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://www.douyin.com/collection/712345678901" }),
  ).toHaveAttribute("target", "_blank");
  const button = page.getByRole("button", { name: "核验通过", exact: true });
  await expect(button).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "实际核验集数" })).toHaveValue("2");
  await shot(page, "pass-verify-before");
  for (const check of await page.getByRole("checkbox").all()) await check.check();
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/launch-submissions/") &&
      request.url().endsWith("/approve")
    ) {
      writes++;
      expect(request.headers()["idempotency-key"]).toBeTruthy();
    }
  });
  await button.evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect(page.getByText("没有符合条件的事项", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "待核验 0", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue(item.name);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("searchbox").press("Enter");
  await expect(page.getByText("暂无待核验链接", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  const ticket = await data<{ step: string }>(
    await page.request.get(`/api/v1/admin/delivery-tickets/${item.ticketId}`),
  );
  expect(ticket.step).toBe("in_service");
  const task = await data<ResponseOf<"m.launchTask.get">>(
    await page.request.get(`/api/v1/m/launch-tasks/${taskId}`, { headers: item.headers }),
  );
  expect(task.task.isLive).toBe(true);
  await page.getByRole("tab", { name: /今日已核验/ }).click();
  await page.getByRole("button", { name: new RegExp(item.name) }).click();
  await expect(page.getByTestId("queue-result")).toHaveText("链接已通过核验");
  await shot(page, "pass-verify-after");
  expect(errors).toEqual([]);
});
test("真实交付退回链：链接核验原因说明必填、隐藏暂停轮询与处理后空态", async ({ page }) => {
  const errors = recordErrors(page),
    item = fixture().items.find((row) => row.outcome === "reject");
  if (!item) throw new Error("W120 退回链缺失");
  const taskId = await push(page, item);
  await page.clock.install();
  let polls = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v1/admin/approvals" &&
      url.searchParams.get("kind") === "launch_link"
    )
      polls++;
  });
  await page.goto(`/publish/verify?q=${item.name}`);
  await expect(page.getByRole("heading", { name: "商家提交链接", exact: true })).toBeVisible();
  const original = polls;
  await page.clock.fastForward(31_000);
  await expect.poll(() => polls).toBeGreaterThan(original);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = polls;
  await page.clock.fastForward(61_000);
  expect(polls).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "退回修改", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "退回链接修改" }),
    button = dialog.getByRole("button", { name: "确认驳回" });
  await expect(button).toBeDisabled();
  await expect(dialog.getByRole("radio").first()).toBeVisible();
  await dialog.getByRole("radio").first().check();
  await expect(button).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "驳回说明" })
    .fill("合集缺少第二集，请补正链接后重新回填");
  await expect(button).toBeEnabled();
  await shot(page, "reject-dialog");
  await button.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("没有符合条件的事项", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "待核验 0", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue(item.name);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("searchbox").press("Enter");
  await page.clock.fastForward(500);
  await expect(page.getByText("暂无待核验链接", { exact: true })).toBeVisible();
  const task = await data<ResponseOf<"m.launchTask.get">>(
    await page.request.get(`/api/v1/m/launch-tasks/${taskId}`, { headers: item.headers }),
  );
  expect(task.task).toMatchObject({ isLive: false, reviewStatus: "need_fix" });
  await page.getByRole("tab", { name: /今日已核验/ }).click();
  await page.getByRole("button", { name: new RegExp(item.name) }).click();
  await expect(page.getByTestId("queue-result")).toHaveText("链接已退回修改");
  await shot(page, "reject-verify-after");
  expect(errors).toEqual([]);
});
