import { expect, test, type Page } from "@playwright/test";
import { PublishListReplaceBodySchema } from "@liyoxi/contract";
import { liveContext, recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";
import { planInput } from "../../src/features/delivery/ticket-detail/model";
import { publishInput } from "../../src/features/delivery/ticket-detail/publish-list-model";
import {
  adminHeaders,
  checklist,
  control,
  documents,
  expectedResourceError,
  launchCalendar,
  publishList,
  read,
  shot,
  submission,
  ticket,
  tracks,
  viewerLogin,
  w608Fixture,
  write,
} from "./live-m6-publish-fixture";

// One small, actual writer chain. Existing test/expect budgets, worker count and retry policy apply.
test.describe.configure({ mode: "serial" });
const listPath = () =>
  `/api/v1/admin/delivery-tickets/${w608Fixture().scope.ticketId}/publish-list`;
const visitList = (page: Page) =>
  page.goto(`/delivery/tickets/${w608Fixture().ticketNo}?tab=publish`);
const confirmList = (page: Page) =>
  page.getByRole("checkbox", { name: "我已核对完整清单及本次修改", exact: true }).check();
const doubleClick = async (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
let approvedSubmissionId: string, approvedApprovalId: string;

test.afterAll(async () => {
  expect(await documents("cleanup-docs")).toMatchObject({ ticketId: w608Fixture().scope.ticketId });
});

test("W608 全店候选包含订单外账号，跨店真实拒绝，方案替换与推送读回", async ({ page }) => {
  const f = w608Fixture(),
    errors = recordErrors(page),
    path = `/api/v1/admin/delivery-plans/${f.scope.planId}`;
  await ensureLiveStepUp(page);
  const before = await read(page.request, path),
    original = planInput(before);
  expect(original.items[0]!.channelAccountIds).toEqual([f.accounts[0]!.id]);
  const foreign = structuredClone(original);
  foreign.items[0]!.channelAccountIds = [f.foreignAccount.id];
  const rejected = await page.request.put(`${path}/draft`, {
    data: { draftLockVersion: before.draftLockVersion, content: foreign },
    headers: { ...adminHeaders(), "Idempotency-Key": crypto.randomUUID() },
  });
  expect(rejected.status()).toBe(404);
  expect(planInput(await read(page.request, path))).toEqual(original);
  await page.goto(`/delivery/tickets/${f.ticketNo}?tab=plan`);
  await page.getByRole("button", { name: "配置方案", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "配置交付方案", exact: true });
  await drawer.getByRole("combobox", { name: "发布账号", exact: true }).click();
  await expect(page.getByTitle(`${f.accounts[1]!.name} · 视频号`, { exact: true })).toBeVisible();
  await expect(page.getByText(f.foreignAccount.name, { exact: true })).toHaveCount(0);
  await shot(page, "w608-01-store-account-candidates", drawer);
  await page.getByTitle(`${f.accounts[1]!.name} · 视频号`, { exact: true }).click();
  await drawer.getByLabel("约定上线日", { exact: true }).fill(f.launchDate);
  await drawer.getByLabel("预计交付日", { exact: true }).fill(f.deliveryDate);
  await drawer.getByRole("checkbox", { name: "我已核对全部发布账号与方案", exact: true }).check();
  const saves: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname === `${path}/draft`)
      saves.push(r.headers()["idempotency-key"]!);
  });
  await doubleClick(page, "保存方案");
  await expect(drawer).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toBeTruthy();
  const saved = await read(page.request, path),
    content = planInput(saved);
  expect(content.items[0]!.channelAccountIds.sort()).toEqual([...f.scope.accountIds].sort());
  expect(content.items[0]).toMatchObject({
    agreedLaunchDate: f.launchDate,
    expectedDeliveryDate: f.deliveryDate,
  });
  await page.getByRole("button", { name: "推送方案", exact: true }).click();
  const push = page.getByRole("dialog", { name: "推送交付方案", exact: true });
  await push.getByRole("checkbox", { name: "我已核对方案与发布账号", exact: true }).check();
  await push.getByRole("button", { name: "确认推送", exact: true }).click();
  await expect(push).toHaveCount(0);
  await write(
    page.request,
    `/api/v1/m/delivery-plans/${f.scope.planId}/confirm`,
    { versionNo: 1 },
    "post",
    f.ownerHeaders,
  );
  expect((await ticket(page.request)).step).toBe("sample_making");
  expect(errors).toEqual([]);
});

test("W608 实际样片上传、探测与水印到就绪", async ({ page }) => {
  expect((await control(page.request, "upload_sample")).fileId).toBeTruthy();
  await expect.poll(async () => (await control(page.request, "finish_sample")).ready).toBe(true);
});
test("W608 实际样片确认与第二集成片上传、探测", async ({ page }) => {
  expect(await control(page.request, "confirm_sample")).toMatchObject({
    physicalWatermarkVerified: true,
  });
  expect((await control(page.request, "upload_final")).fileId).toBeTruthy();
  await expect.poll(async () => (await control(page.request, "finish_final")).ready).toBe(true);
});
test("W608 真实逐集及整包质检，再真实渲染两平台授权书", async ({ page }) => {
  expect(await control(page.request, "inspect_package")).toMatchObject({
    ticketId: w608Fixture().scope.ticketId,
    step: "delivering",
  });
  expect(await documents("render")).toMatchObject({
    ticketId: w608Fixture().scope.ticketId,
    ready: true,
    rendered: 2,
    letters: 2,
    signMode: "platform_cert",
    technicalTestCertificate: true,
  });
});

test("W608 CSV多错行零写、修正导入与完整替换均真实读回", async ({ page }) => {
  const errors = recordErrors(page),
    before = await publishList(page.request);
  expect(before.isEditable).toBe(true);
  await visitList(page);
  const input = page.getByRole("textbox", { name: "表格内容", exact: true });
  await input.fill(
    `集号,看点,标题,话题,简介\n1,开场,${"长".repeat(101)},话题,简介\n2,${"长".repeat(31)},结尾,话题,简介`,
  );
  await confirmList(page);
  const invalid = await expectedResourceError(page, errors, 400, () =>
    page.getByRole("button", { name: "导入逐集清单", exact: true }).click(),
  );
  expect(await invalid.json()).toMatchObject({
    error: "PUBLISH_LIST_IMPORT_INVALID",
    details: {
      rows: expect.arrayContaining([
        expect.objectContaining({ rowNo: 2, column: "标题" }),
        expect.objectContaining({ rowNo: 3, column: "看点" }),
      ]),
    },
  });
  await expect(page.getByText(/第 2 行 · 标题：/)).toBeVisible();
  await expect(page.getByText(/第 3 行 · 看点：/)).toBeVisible();
  expect((await publishList(page.request)).lockVersion).toBe(before.lockVersion);
  expect((await publishList(page.request)).episodes).toEqual(before.episodes);
  await shot(page, "w608-02-list-import-errors");
  await page.getByRole("button", { name: "刷新版本并保留输入", exact: true }).click();
  await expect(input).toHaveValue(/长/);
  await input.fill(
    "集号,看点,标题,话题,简介\n1,开场悬念,第一集真实导入,#门店故事,第一集简介\n2,结尾揭晓,第二集真实导入,#门店故事,第二集简介",
  );
  await confirmList(page);
  const importRequests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === `${listPath()}/import`)
      importRequests.push(r.headers()["idempotency-key"]!);
  });
  await doubleClick(page, "导入逐集清单");
  await expect
    .poll(async () => (await publishList(page.request)).episodes.map((e) => e.title))
    .toEqual(["第一集真实导入", "第二集真实导入"]);
  expect(importRequests).toHaveLength(1);
  await page.getByRole("textbox", { name: "合集名称", exact: true }).fill("门店的两集故事");
  await page
    .getByRole("textbox", { name: "标题模板", exact: true })
    .fill("{剧名} · 第{集数}集 · {看点}");
  await page
    .getByRole("textbox", { name: "通用简介", exact: true })
    .fill("真实写入后重新读取的通用简介。");
  const topics = page.getByRole("combobox", { name: "通用话题", exact: true });
  await topics.fill("同城门店");
  await topics.press("Enter");
  await confirmList(page);
  const replacement = page.waitForResponse(
    (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === listPath(),
  );
  await doubleClick(page, "保存发布清单");
  expect((await replacement).status()).toBe(200);
  const saved = await publishList(page.request);
  expect(saved).toMatchObject({
    collectionName: "门店的两集故事",
    titleTemplate: "{剧名} · 第{集数}集 · {看点}",
    intro: "真实写入后重新读取的通用简介。",
    cover: { fileId: w608Fixture().scope.posterFileId },
  });
  expect(saved.topics).toContain("同城门店");
  expect(saved.completeness.isComplete).toBe(true);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "合集名称", exact: true })).toHaveValue(
    "门店的两集故事",
  );
  await shot(page, "w608-03-list-saved");
  expect(errors).toEqual([]);
});

test("W608 清单409保留输入，刷新版本后重新确认", async ({ page }) => {
  const errors = recordErrors(page);
  await visitList(page);
  await expect(page.getByRole("textbox", { name: "合集名称", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "合集名称", exact: true }).fill("页面保留的新合集名称");
  const original = await publishList(page.request),
    concurrent = PublishListReplaceBodySchema.parse({
      ...publishInput(original),
      lockVersion: original.lockVersion,
    });
  await write(
    page.request,
    listPath(),
    { ...concurrent, lockVersion: original.lockVersion, collectionName: "另一真实写入的合集" },
    "put",
  );
  await confirmList(page);
  await expectedResourceError(page, errors, 409, () =>
    page.getByRole("button", { name: "保存发布清单", exact: true }).click(),
  );
  await expect(page.getByRole("textbox", { name: "合集名称", exact: true })).toHaveValue(
    "页面保留的新合集名称",
  );
  expect((await publishList(page.request)).collectionName).toBe("另一真实写入的合集");
  await page.getByRole("button", { name: "刷新版本并保留输入", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "我已核对完整清单及本次修改", exact: true }),
  ).not.toBeChecked();
  await confirmList(page);
  await page.getByRole("button", { name: "保存发布清单", exact: true }).click();
  await expect
    .poll(async () => (await publishList(page.request)).collectionName)
    .toBe("页面保留的新合集名称");
  expect(errors).toEqual([]);
});

test("W608 推包后显式pack building，真实压缩失败后人工重试至ready", async ({ page }) => {
  const f = w608Fixture(),
    errors = recordErrors(page);
  await ensureLiveStepUp(page);
  await write(page.request, `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/push-package`, {
    precheck: await checklist(page.request, "delivery.precheck"),
  });
  expect((await ticket(page.request)).step).toBe("awaiting_launch");
  const initial = await control(page.request, "observe_zip");
  expect(initial).toMatchObject({
    zipState: "building",
    zipGen: 1,
    jobState: "queued",
    archive: null,
  });
  const packs: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname ===
        `/api/v1/admin/delivery-releases/${initial.deliveryReleaseId}/pack`
    )
      packs.push(r.headers()["idempotency-key"]!);
  });
  await visitList(page);
  const button = page.getByRole("button", { name: "预打包 / 查看或重试打包", exact: true });
  await expect(button).toBeVisible();
  expect(packs).toHaveLength(0);
  await doubleClick(page, "预打包 / 查看或重试打包");
  await expect(page.getByText("正在打包 · 第 1 次打包", { exact: true })).toBeVisible();
  expect(packs).toHaveLength(1);
  await shot(page, "w608-04-pack-building");
  expect(await control(page.request, "fail_next_zip")).toMatchObject({ zipGen: 1, armed: true });
  expect(await control(page.request, "run_zip")).toMatchObject({
    zipGen: 1,
    zipState: "failed",
    jobState: "failed",
    archive: null,
  });
  // This backend uses retry:true; clicking cannot return the previous failed DTO. No fake failed screenshot.
  await expect(page.getByText("正在打包 · 第 1 次打包", { exact: true })).toBeVisible();
  expect(packs).toHaveLength(1);
  await button.click();
  await expect(page.getByText("正在打包 · 第 2 次打包", { exact: true })).toBeVisible();
  const completed = await control(page.request, "run_zip");
  expect(completed).toMatchObject({
    zipGen: 2,
    zipState: "ready",
    jobState: "succeeded",
    archive: { fileCount: 3 },
  });
  expect(completed.archive.sizeBytes).toBeGreaterThan(22);
  expect(completed.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
  await button.click();
  await expect(page.getByText("打包完成 · 第 2 次打包", { exact: true })).toBeVisible();
  expect(packs).toHaveLength(3);
  expect(new Set(packs).size).toBe(3);
  await shot(page, "w608-05-pack-ready");
  await page.reload();
  await expect(button).toBeVisible();
  await expect(page.getByText("尚未确认打包状态", { exact: true })).toBeVisible();
  expect(packs).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("W608 pack传输错误真实可见，同意图重试仍用原幂等键", async ({ page }) => {
  const errors = recordErrors(page),
    current = await control(page.request, "observe_zip");
  expect(current.zipState).toBe("ready");
  const path = `/api/v1/admin/delivery-releases/${current.deliveryReleaseId}/pack`,
    keys: string[] = [],
    failed: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === path)
      keys.push(request.headers()["idempotency-key"]!);
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === path) failed.push(request.failure()?.errorText ?? "");
  });
  await visitList(page);
  await page.route(`**${path}`, (route) => route.abort("failed"));
  try {
    await page.getByRole("button", { name: "预打包 / 查看或重试打包", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Failed to fetch" })).toBeVisible();
    await expect.poll(() => failed).toEqual(["net::ERR_FAILED"]);
    await expect.poll(() => errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
    expect(keys).toHaveLength(1);
    await shot(page, "w608-05b-pack-transport-error");
    errors.splice(0, 1);
  } finally {
    await page.unroute(`**${path}`);
  }
  await page.getByRole("button", { name: "预打包 / 查看或重试打包", exact: true }).click();
  await expect(
    page.getByText(`打包完成 · 第 ${current.zipGen} 次打包`, { exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await control(page.request, "observe_zip")).zipGen).toBe(current.zipGen);
  expect(errors).toEqual([]);
});

test("W608 实际日历与按账号逾期状态，跟进写入后GET读回", async ({ page }) => {
  const f = w608Fixture(),
    errors = recordErrors(page),
    current = await launchCalendar(page.request, f.launchDate, f.launchDate);
  const item = current.days
    .flatMap((day) => day.items)
    .find((r) => r.orderItemId === f.scope.itemId);
  expect(item).toMatchObject({ calendarStatus: "overdue", isDeliveryLate: true });
  expect(item!.tasks).toHaveLength(2);
  await page.goto(
    `/publish/calendar?month=${f.launchDate.slice(0, 7)}&date=${f.launchDate}&managerId=${f.scope.managerId}`,
  );
  const day = page.getByRole("button", { name: f.launchDate, exact: true });
  await expect(day).toBeVisible();
  await day.focus();
  await day.press("Enter");
  const details = page.getByRole("complementary", { name: "当日上线安排", exact: true });
  await expect(details).toContainText(f.storeName);
  await expect(details).toContainText(f.title);
  await shot(page, "w608-06-calendar-overdue");
  await page.goto(
    `/publish/overdue?tab=overdue&orderItemId=${f.scope.itemId}&id=${f.scope.itemId}`,
  );
  const tracked = (await tracks(page.request)).items[0]!;
  expect(tracked.overdue?.reason).toBe("late_delivery");
  expect(tracked.tasks).toHaveLength(2);
  const panel = page.getByRole("complementary", { name: "上线任务详情", exact: true });
  await expect(panel).toContainText("成片晚交");
  for (const account of f.accounts) await expect(panel).toContainText(account.name);
  await shot(page, "w608-07-overdue-tasks");
  await panel.getByRole("button", { name: "记录跟进", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "记录跟进", exact: true }),
    text = "已电话确认两平台发布安排，继续核对上线链接。";
  await modal.getByRole("textbox", { name: "跟进内容", exact: true }).fill(text);
  await modal.getByRole("checkbox", { name: "我已核对跟进对象和内容", exact: true }).check();
  await modal.getByRole("button", { name: "保存跟进", exact: true }).click();
  await expect(modal).toHaveCount(0);
  const follows = await read(
    page.request,
    `/api/v1/admin/follow-ups?subjectType=order_item&subjectId=${f.scope.itemId}&page=1&pageSize=20`,
  );
  expect(follows.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ content: text })]),
  );
  await expect(panel).toContainText(text);
  expect(errors).toEqual([]);
});

test("W608 日历真实节假日、调休与未导入年度，空结果可见", async ({ page }) => {
  const errors = recordErrors(page);
  const october = await launchCalendar(page.request, "2026-10-01", "2026-10-31");
  const holiday = october.workCalendar.days.find((day) => day.kind === "holiday"),
    adjusted = october.workCalendar.days.find((day) => day.kind === "adjusted_workday");
  expect(holiday).toBeTruthy();
  expect(adjusted).toBeTruthy();
  await page.goto("/publish/calendar?month=2026-10");
  await expect(page.getByRole("button", { name: holiday!.date, exact: true })).toContainText(
    holiday!.name!,
  );
  await expect(page.getByRole("button", { name: adjusted!.date, exact: true })).toContainText(
    "调休上班",
  );
  await shot(page, "w608-08-calendar-holidays");
  const missing = await launchCalendar(page.request, "2099-01-01", "2099-01-31");
  expect(missing.workCalendar.years.every((year) => year.importedAt === null)).toBe(true);
  await page.goto("/publish/calendar?month=2099-01&date=2099-01-01");
  await expect(page.getByText(/2099 年节假日安排尚未导入/)).toBeVisible();
  await expect(page.getByRole("button", { name: "2099-01-01", exact: true })).toContainText(
    "缺少日历",
  );
  await shot(page, "w608-09-calendar-missing-empty");
  await page.goto("/publish/overdue?tab=all&q=W608不存在的订单");
  await expect(page.getByText("当前范围暂无上线任务", { exact: true })).toBeVisible();
  await shot(page, "w608-10-overdue-empty");
  expect(errors).toEqual([]);
});

for (const scenario of [
  {
    name: "日历",
    page: "/publish/calendar",
    api: "/api/v1/admin/launch-calendar",
    shot: "w608-10b-calendar-load-error",
  },
  {
    name: "逾期",
    page: "/publish/overdue?tab=overdue",
    api: "/api/v1/admin/launch-tasks",
    shot: "w608-10c-overdue-load-error",
  },
])
  test(`W608 ${scenario.name}真实传输失败可见，人工重载恢复`, async ({ page }) => {
    const errors = recordErrors(page),
      failures: { url: string; reason: string }[] = [],
      pattern = `**${scenario.api}?*`;
    page.on("requestfailed", (r) =>
      failures.push({ url: r.url(), reason: r.failure()?.errorText ?? "" }),
    );
    await page.route(pattern, (route) => route.abort("failed"));
    try {
      await page.goto(scenario.page);
      const failed = page.getByRole("alert").filter({ hasText: "加载失败" });
      await expect(failed).toBeVisible();
      await expect(failed).toContainText("Failed to fetch");
      await expect.poll(() => failures.length).toBe(1);
      expect(new URL(failures[0]!.url).pathname).toBe(scenario.api);
      expect(failures[0]!.reason).toBe("net::ERR_FAILED");
      await expect.poll(() => errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
      await shot(page, scenario.shot);
      errors.splice(0, 1);
    } finally {
      await page.unroute(pattern);
    }
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "加载失败" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: scenario.name === "日历" ? "上线日历" : "逾期跟进",
        exact: true,
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

test("W608 商家真实提交两账号链接，实际核验通过", async ({ page }) => {
  const f = w608Fixture();
  await ensureLiveStepUp(page);
  for (const task of (await tracks(page.request)).items[0]!.tasks) {
    await write(
      page.request,
      `/api/v1/m/launch-tasks/${task.launchTaskId}/submit`,
      {
        linkKind: "episodes",
        collectionUrl: `https://example.invalid/w608/${task.launchTaskId}`,
        episodeUrls: [1, 2].map((episodeNo) => ({
          episodeNo,
          url: `https://example.invalid/w608/${task.launchTaskId}/${episodeNo}`,
        })),
        reportedEpisodeCount: 2,
        actualLaunchDate: f.launchDate,
      },
      "post",
      f.ownerHeaders,
    );
    const latest = (await tracks(page.request)).items[0]!.tasks.find(
      (one) => one.launchTaskId === task.launchTaskId,
    )!;
    expect(latest.currentSubmissionId).toBeTruthy();
    const detail = await submission(page.request, latest.currentSubmissionId!);
    const passed = await write(
      page.request,
      `/api/v1/admin/launch-submissions/${detail.launchSubmissionId}/approve`,
      {
        lockVersion: detail.approval.lockVersion,
        confirm: { roundNo: detail.roundNo, reportedEpisodeCount: 2 },
        verifiedEpisodeCount: 2,
        ...(await checklist(page.request, "launch.verify")),
      },
    );
    expect(passed.result).toBe("passed");
    approvedSubmissionId = detail.launchSubmissionId;
    approvedApprovalId = detail.approval.approvalId;
  }
  expect(
    (await tracks(page.request)).items[0]!.tasks.every(
      (task) => task.isLive && task.reviewStatus === "passed",
    ),
  ).toBe(true);
});

test("W608 真实publish只读且无system查看：入口可读，清单替换和撤销拒绝", async ({ browser }) => {
  const login = await viewerLogin(),
    context = await browser.newContext({
      baseURL: liveContext().origin,
      storageState: { cookies: login.cookies, origins: [] },
      viewport: { width: 1366, height: 768 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
  try {
    const page = await context.newPage(),
      errors = recordErrors(page),
      f = w608Fixture(),
      requests: string[] = [];
    const me = await read(page.request, "/api/v1/admin/auth/me");
    expect(me.staff.staffId).toBe(login.staffId);
    expect(me.moduleLevels).toMatchObject({ publish: "v", system: "n", delivery: "v" });
    page.on("request", (r) => {
      if (r.method() === "GET") requests.push(r.url());
    });
    await page.goto(`/publish/calendar?month=${f.launchDate.slice(0, 7)}`);
    await expect(page.getByRole("heading", { name: "上线日历", exact: true })).toBeVisible();
    // This existing cs actor has service.ticket.transfer, so the authorized pool picker is valid.
    await expect(page.getByRole("combobox", { name: "交付经理", exact: true })).toBeVisible();
    const staffReads = requests
      .map((url) => new URL(url))
      .filter((url) => url.pathname === "/api/v1/admin/staff");
    expect(staffReads.length).toBeGreaterThan(0);
    expect(staffReads.every((url) => url.searchParams.get("pool") === "delivery_manager")).toBe(
      true,
    );
    await visitList(page);
    await expect(page.getByRole("textbox", { name: "合集名称", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存发布清单", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "预打包 / 查看或重试打包", exact: true }),
    ).toHaveCount(0);
    const current = await publishList(page.request);
    const replace = await page.request.put(listPath(), {
      data: { ...publishInput(current), lockVersion: current.lockVersion },
      headers: { ...adminHeaders(), "Idempotency-Key": crypto.randomUUID() },
    });
    expect(replace.status()).toBe(403);
    await page.goto(`/publish/verify?tab=done_today&id=${approvedApprovalId}`);
    await expect(page.getByRole("button", { name: "撤销核验", exact: true })).toHaveCount(0);
    const old = await submission(page.request, approvedSubmissionId);
    const revoke = await page.request.post(
      `/api/v1/admin/launch-submissions/${approvedSubmissionId}/revoke`,
      {
        data: {
          reason: "只读人员无权撤销核验",
          confirm: { roundNo: old.roundNo, verifiedEpisodeCount: 2 },
        },
        headers: { ...adminHeaders(), "Idempotency-Key": crypto.randomUUID() },
      },
    );
    expect(revoke.status()).toBe(403);
    expect((await submission(page.request, approvedSubmissionId)).result).toBe("passed");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("W608 撤销确认取最新轮次与集数，实际执行后GET新pending轮次", async ({ page }) => {
  const errors = recordErrors(page);
  await ensureLiveStepUp(page);
  await page.goto(`/publish/verify?tab=done_today&id=${approvedApprovalId}`);
  const old = await submission(page.request, approvedSubmissionId);
  expect(old.revoke?.canRevoke).toBe(true);
  const refreshed = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname === `/api/v1/admin/launch-submissions/${approvedSubmissionId}`,
  );
  await page.getByRole("button", { name: "撤销核验", exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  const modal = page.getByRole("dialog", { name: "撤销已通过的核验", exact: true });
  await expect(modal).toContainText(`第 ${old.roundNo} 轮`);
  await expect(modal).toContainText("2 集");
  await modal
    .getByRole("textbox", { name: "撤销原因", exact: true })
    .fill("重新复核发现第二集链接对应作品错误，需要重新核验。");
  await modal
    .getByRole("checkbox", { name: "我已核对本轮集数并确认重开核验", exact: true })
    .check();
  await shot(page, "w608-11-revoke-confirm", modal);
  const revoked = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname ===
        `/api/v1/admin/launch-submissions/${approvedSubmissionId}/revoke`,
  );
  await doubleClick(page, "确认撤销核验");
  const response = await revoked;
  expect(response.status()).toBe(200);
  const result = (await response.json()).data;
  await expect(modal).toHaveCount(0);
  expect(result.launchSubmissionId).not.toBe(approvedSubmissionId);
  const fresh = await submission(page.request, result.launchSubmissionId);
  expect(fresh).toMatchObject({
    result: "pending",
    isCurrentRound: true,
    roundNo: old.roundNo + 1,
    reopenOfLaunchSubmissionId: approvedSubmissionId,
    approval: { status: "pending" },
  });
  const historical = await submission(page.request, approvedSubmissionId);
  expect(historical.isCurrentRound).toBe(false);
  expect(historical.result).toBe("passed");
  const task = (await tracks(page.request)).items[0]!.tasks.find(
    (item) => item.launchTaskId === fresh.launchTaskId,
  )!;
  expect(task).toMatchObject({
    currentSubmissionId: fresh.launchSubmissionId,
    reviewStatus: "verifying",
    isLive: false,
  });
  await page.goto(`/publish/verify?tab=todo&id=${fresh.approval.approvalId}`);
  await expect(page.getByText(fresh.account.accountName, { exact: true }).first()).toBeVisible();
  await shot(page, "w608-12-reopened-verification");
  expect(errors).toEqual([]);
});
