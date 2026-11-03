import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ChannelAccountDetailSchema,
  PatrolTaskDetailSchema,
  TakedownTaskDetailSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { syntheticImage } from "./w312-media";
interface Fixture {
  storeId: string;
  live: { patrolTaskId: string; accountId: string; title: string };
  offline: { takedownTaskId: string; accountId: string; title: string; name: string }[];
  health: { accountId: string; name: string };
  pending: { accountId: string; submissionId: string; name: string };
  patrolIssueName: string;
  headers: Record<string, string>;
}
const fixture = () => (liveContext().fixtures as { fixtures: { w609: Fixture } }).fixtures.w609;
const adminHeaders = (page: Page) => ({
  "X-LYX-Admin": "1",
  Origin: new URL(page.url()).origin,
  "X-Client-Version": "1.0.0",
});
async function read(page: Page, path: string) {
  const response = await page.request.get(`/api/v1/admin/${path}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as unknown;
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  mkdirSync("dist/e2e-shots", { recursive: true });
  const deadline = Date.now() + 10_000;
  let stable: Buffer | undefined;
  await expect
    .poll(
      async () => {
        const first = await page.screenshot({
          path: `dist/e2e-shots/w609-${name}-first.png`,
          animations: "disabled",
          timeout: Math.max(1, deadline - Date.now()),
        });
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
        const second = await page.screenshot({
          path: `dist/e2e-shots/w609-${name}-second.png`,
          animations: "disabled",
          timeout: Math.max(1, deadline - Date.now()),
        });
        if (first.equals(second)) stable = second;
        return !!stable;
      },
      { timeout: 10_000, intervals: [100], message: `${name} 两帧稳定` },
    )
    .toBe(true);
  writeFileSync(`dist/e2e-shots/w609-${name}.png`, stable!);
  await page.setViewportSize({ width: 1366, height: 768 });
}
async function option(page: Page, label: string, name: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: name })
    .first()
    .click();
}
async function evidence(dialog: Locator, count: number) {
  for (let index = 0; index < count; index++) {
    await dialog
      .locator('input[type="file"]')
      .nth(index)
      .setInputFiles(syntheticImage(`隔离验收截图-${index + 1}.png`));
    await expect(dialog.locator(".ant-upload-list-item-done")).toHaveCount(index + 1);
  }
}
async function confirm(dialog: Locator, double = false) {
  await dialog.getByRole("checkbox", { name: "我已核对当前对象与本次操作", exact: true }).check();
  const button = dialog.getByRole("button", { name: "确认", exact: true });
  await expect(button).toBeEnabled();
  if (double)
    await button.evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
  else await button.click();
}

test("巡检：真实异常、限频提醒与新证据恢复，账号状态独立", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page);
  await page.goto(`/publish/patrol?storeId=${f.storeId}&id=${f.live.patrolTaskId}`);
  await expect(page.getByRole("heading", { name: "巡检详情", exact: true })).toBeVisible();
  await expect(page.getByText("尚未巡检", { exact: true })).toBeVisible();
  await shot(page, "patrol-pending");
  await page.getByRole("button", { name: "发现异常", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "发现异常", exact: true });
  await option(page, "异常类型", f.patrolIssueName);
  await dialog.getByLabel("异常说明", { exact: true }).fill("本轮隔离验收记录的链接异常");
  await evidence(dialog, 1);
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/${f.live.patrolTaskId}/mark-abnormal`)
    )
      writes++;
  });
  await confirm(dialog, true);
  await expect(dialog).toBeHidden();
  expect(writes).toBe(1);
  let actual = PatrolTaskDetailSchema.parse(
    await read(page, `patrol-tasks/${f.live.patrolTaskId}`),
  );
  expect(actual.status).toBe("abnormal");
  expect(actual.evidenceFileIds).toHaveLength(1);
  const firstEvidence = actual.evidenceFileIds[0],
    remindersBefore = actual.remindCount;
  await shot(page, "patrol-abnormal");
  await page.getByRole("button", { name: "再次提醒商家", exact: true }).click();
  await confirm(page.getByRole("dialog", { name: "再次提醒商家", exact: true }));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "再次提醒商家", exact: true })).toHaveCount(0);
  const reminded = PatrolTaskDetailSchema.parse(
    await read(page, `patrol-tasks/${f.live.patrolTaskId}`),
  );
  expect(reminded.isRemindedToday).toBe(true);
  expect(reminded.remindCount).toBe(remindersBefore + 1);
  expect(reminded.actions).not.toContain("remind");
  await expect(
    page.getByText(`${reminded.remindCount} 次 · 今日已提醒`, { exact: true }),
  ).toBeVisible();
  const limited = await page.request.post(
    `/api/v1/admin/patrol-tasks/${f.live.patrolTaskId}/remind`,
    { headers: { ...adminHeaders(page), "Idempotency-Key": "w609-remind-limit" }, data: {} },
  );
  expect(limited.status()).toBe(409);
  expect((await limited.json()).error).toBe("REMINDED_TODAY");
  const afterLimited = PatrolTaskDetailSchema.parse(
    await read(page, `patrol-tasks/${f.live.patrolTaskId}`),
  );
  expect(afterLimited.isRemindedToday).toBe(true);
  expect(afterLimited.remindCount).toBe(reminded.remindCount);
  expect(afterLimited.lastRemindedAt).toBe(reminded.lastRemindedAt);
  await page.getByRole("button", { name: "复查已恢复", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "复查已恢复", exact: true });
  await evidence(dialog, 1);
  for (const check of await dialog.locator(".lyx-checklist").getByRole("checkbox").all())
    await check.check();
  await shot(page, "patrol-recover-confirm");
  await confirm(dialog);
  await expect(dialog).toBeHidden();
  actual = PatrolTaskDetailSchema.parse(await read(page, `patrol-tasks/${f.live.patrolTaskId}`));
  expect(actual.status).toBe("recovered");
  expect(actual.evidenceFileIds).toHaveLength(2);
  expect(actual.evidenceFileIds).toContain(firstEvidence);
  expect(
    ChannelAccountDetailSchema.parse(await read(page, `channel-accounts/${f.live.accountId}`))
      .status,
  ).toBe("available");
  await shot(page, "patrol-recovered");
  expect(errors).toEqual([]);
});

test("下架批量：并发事实变化造成整批拒绝，逐项原因保留后重新核查", async ({ page }) => {
  const f = fixture(),
    [a, b] = f.offline;
  if (!a || !b) throw new Error("W609 批量范围缺失");
  const errors = recordErrors(page);
  await page.goto(`/publish/offline?storeId=${f.storeId}&q=W609下架&id=${a.takedownTaskId}`);
  await page.getByRole("button", { name: "批量核查", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "批量核查下架", exact: true });
  await option(page, "选择本批核查任务", a.name);
  await option(page, "选择本批核查任务", b.name);
  await dialog.getByRole("heading", { name: `${a.title} · ${a.name}`, exact: true }).click();
  await evidence(dialog, 4);
  for (const check of await dialog.locator(".lyx-checklist").getByRole("checkbox").all())
    await check.check();
  let observed:
    | {
        items: {
          takedownTaskId: string;
          checklistCode: string;
          checklistVersionNo: number;
          results: unknown[];
          evidenceFileIds: string[];
        }[];
      }
    | undefined;
  await page.route(
    "**/api/v1/admin/takedown-tasks/check",
    async (route) => {
      observed = route.request().postDataJSON() as NonNullable<typeof observed>;
      const target = observed.items.find((item) => item.takedownTaskId === b.takedownTaskId)!;
      const { takedownTaskId, ...body } = target;
      const response = await page.request.post(
        `/api/v1/admin/takedown-tasks/${takedownTaskId}/check`,
        {
          headers: { ...adminHeaders(page), "Idempotency-Key": "w609-concurrent-check" },
          data: body,
        },
      );
      expect(response.status(), await response.text()).toBe(200);
      // The actual backend processes the original request against the changed fact; no response stub.
      await route.continue();
    },
    { times: 1 },
  );
  const batchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/admin/takedown-tasks/check"),
  );
  await confirm(dialog);
  const rejected = await batchResponse;
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).error).toBe("TAKEDOWN_BATCH_REJECTED");
  await expect(dialog.getByText("本批未处理，请逐项纠正后重新确认", { exact: true })).toBeVisible();
  expect(observed?.items).toHaveLength(2);
  expect(
    TakedownTaskDetailSchema.parse(await read(page, `takedown-tasks/${a.takedownTaskId}`)).status,
  ).toBe("pending_merchant");
  expect(
    TakedownTaskDetailSchema.parse(await read(page, `takedown-tasks/${b.takedownTaskId}`)).status,
  ).toBe("checked");
  await dialog
    .getByText("本批未处理，请逐项纠正后重新确认", { exact: true })
    .scrollIntoViewIfNeeded();
  await shot(page, "offline-batch-rejected");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto(`/publish/offline?storeId=${f.storeId}&q=${a.name}&id=${a.takedownTaskId}`);
  await page.getByRole("button", { name: "核查通过", exact: true }).click();
  const single = page.getByRole("dialog", { name: "核查通过", exact: true });
  await evidence(single, 2);
  for (const check of await single.locator(".lyx-checklist").getByRole("checkbox").all())
    await check.check();
  await confirm(single);
  await expect(single).toBeHidden();
  expect(
    TakedownTaskDetailSchema.parse(await read(page, `takedown-tasks/${a.takedownTaskId}`)).status,
  ).toBe("checked");
  // Exactly one deliberately rejected real POST; no general console-error allowlist.
  expect(errors).toEqual([
    "Failed to load resource: the server responded with a status of 409 (Conflict)",
  ]);
});

test("仍在线、逾期升级和提醒分别落史；账号健康异常不替代原核验队列", async ({ page }) => {
  const f = fixture(),
    row = f.offline[2];
  if (!row) throw new Error("W609 仍在线范围缺失");
  const errors = recordErrors(page);
  await page.goto(`/publish/offline?storeId=${f.storeId}&q=${row.name}&id=${row.takedownTaskId}`);
  await page.getByRole("button", { name: "抽查仍在线", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "抽查仍在线", exact: true });
  await dialog.getByLabel("处理说明", { exact: true }).fill("隔离验收：仍能看到测试作品");
  await shot(page, "offline-online-confirm");
  await confirm(dialog);
  await expect(dialog).toBeHidden();
  let actual = TakedownTaskDetailSchema.parse(
    await read(page, `takedown-tasks/${row.takedownTaskId}`),
  );
  expect(actual.status).toBe("pending_merchant");
  expect(actual.stillOnlineCount).toBe(1);
  await page.getByRole("button", { name: "逾期升级", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "逾期升级", exact: true });
  await shot(page, "offline-escalate-confirm");
  await confirm(dialog);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "发送违约提醒", exact: true }).click();
  await confirm(page.getByRole("dialog", { name: "发送违约提醒", exact: true }));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  actual = TakedownTaskDetailSchema.parse(await read(page, `takedown-tasks/${row.takedownTaskId}`));
  expect(actual.escalatedAt).not.toBeNull();
  expect(actual.breachNoticeCount).toBe(1);
  expect(actual.timeline.map((item) => item.kind)).toEqual(
    expect.arrayContaining(["merchant_confirmed", "found_online", "escalated", "breach_notified"]),
  );
  const confirmation = await page.request.post(
    `/api/v1/m/takedown-tasks/${row.takedownTaskId}/confirm`,
    {
      headers: { ...f.headers, "Idempotency-Key": "w609-merchant-reconfirm" },
      data: { method: "not_published" },
    },
  );
  expect(confirmation.status(), await confirmation.text()).toBe(200);
  await page.goto(
    `/publish/accounts?view=health&healthStoreId=${f.storeId}&healthQ=${f.health.name}&healthId=${f.health.accountId}`,
  );
  await page.getByRole("button", { name: "标记账号异常", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "标记账号异常", exact: true });
  await dialog.getByLabel("账号异常原因", { exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  await dialog.getByLabel("账号异常说明", { exact: true }).fill("隔离验收：资料需要重新核验");
  await confirm(dialog);
  await expect(dialog).toBeHidden();
  expect(
    ChannelAccountDetailSchema.parse(await read(page, `channel-accounts/${f.health.accountId}`))
      .status,
  ).toBe("abnormal");
  await shot(page, "account-abnormal");
  await page.goto(`/publish/accounts?q=${f.pending.name}`);
  await expect(page.getByRole("heading", { name: "账号核验", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: f.pending.name, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
