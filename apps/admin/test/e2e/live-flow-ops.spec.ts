import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
interface Fixture {
  timers: { timerId: string; fireAt: string; label: string }[];
  outbox: { outboxEventId: string; subscriber: string; label: string }[];
  webhooks: { webhookEventId: string; eventId: string; label: string }[];
}
const fixture = () => (liveContext().fixtures as { fixtures: { w223: Fixture } }).fixtures.w223;
function response(page: Page, method: string, path: string) {
  return page.waitForResponse(
    (result) =>
      result.request().method() === method &&
      new URL(result.url()).pathname === `/api/v1/admin/${path}`,
  );
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
async function ordinaryConfirm(page: Page) {
  await page.getByRole("button", { name: "继续确认", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "确认操作", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "我已核对目标与操作影响" }).check();
  return dialog;
}
function row(page: Page, key: string) {
  return page.locator(`tr[data-row-key="${key}"]`);
}

type WirePost = { path: string; body: string; key: string | null };
async function observeActionRequests(page: Page, paths: string[]) {
  await page.evaluate((allowedPaths) => {
    const nativeFetch = globalThis.fetch,
      records: WirePost[] = [],
      pending: Promise<void>[] = [];
    let overflow = false;
    const state = globalThis as typeof globalThis & { __w223Wire: () => Promise<WirePost[]> };
    state.__w223Wire = async () => {
      await Promise.all(pending);
      if (overflow) throw new Error("W223出现额外写请求");
      return records;
    };
    globalThis.fetch = (input, init) => {
      if (
        !(input instanceof Request) ||
        input.method !== "POST" ||
        !allowedPaths.includes(new URL(input.url).pathname)
      )
        return nativeFetch(input, init);
      if (pending.length >= 5) {
        overflow = true;
        return nativeFetch(input, init);
      }
      const copy = input.clone(),
        path = new URL(input.url).pathname,
        key = input.headers.get("Idempotency-Key");
      // 原input/init立即原样外发；只读副本并行读取，不拦截网络或等待正文后才发送。
      const result = nativeFetch(input, init);
      pending.push(
        copy.text().then((body) => {
          records.push({ path, body, key });
        }),
      );
      return result;
    };
  }, paths);
}
async function wirePosts(page: Page) {
  return page.evaluate(() =>
    (globalThis as typeof globalThis & { __w223Wire: () => Promise<WirePost[]> }).__w223Wire(),
  );
}
async function expectWireBody(page: Page, path: string, body: object) {
  const records = (await wirePosts(page)).filter((record) => record.path === path);
  expect(records).toHaveLength(1);
  expect(records[0]!.body).toBe(JSON.stringify(body));
  expect(records[0]!.key).toMatch(/^[A-Za-z0-9:_-]{1,128}$/);
}

async function auditCount(page: Page, targetType: string, targetId: string) {
  const result = await page.request.get(
    `/api/v1/admin/audit-logs?stream=ops&category=system_ops&targetType=${targetType}&targetId=${targetId}`,
  );
  expect(result.status()).toBe(200);
  return (await result.json()).data.totalApprox as number;
}
test("W223 三资源真实分页/游标、URL筛选与日期键盘，只读查询零写", async ({ page }) => {
  const item = fixture(),
    errors = recordErrors(page),
    writes: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      writes.push(request.method());
  });
  const initial = response(page, "GET", "timers");
  await page.goto(
    "/sys/flow-ops?kind=ops.retention&pageSize=10&subjectType=drama_order&subjectId=bad&fireFrom=2026-10-08&fireTo=2026-10-07&uiOnly=x",
  );
  const first = await initial;
  expect(first.status()).toBe(200);
  const qs = new URL(first.url()).searchParams;
  for (const key of ["subjectType", "subjectId", "fireFrom", "fireTo", "uiOnly", "cursor"])
    expect(qs.has(key)).toBe(false);
  await expect(page.getByRole("heading", { name: "流程运维", exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11);
  const timers = (await first.json()).data.items.map((value: { timerId: string }) => value.timerId),
    nextTimer = response(page, "GET", "timers");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  timers.push(
    ...(await (await nextTimer).json()).data.items.map(
      (value: { timerId: string }) => value.timerId,
    ),
  );
  expect(new Set(timers)).toEqual(new Set(item.timers.map((value) => value.timerId)));
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await shot(page, "flow-ops-01-failed-timers");
  const form = page.getByRole("form", { name: "流程运维筛选" }),
    start = form.getByPlaceholder("开始日期"),
    end = form.getByPlaceholder("结束日期");
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ant-picker-dropdown:visible")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-picker-dropdown:visible")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(end).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button", { name: "查询", exact: true })).toBeFocused();
  const outboxRequest = response(page, "GET", "outbox-deliveries");
  await page.getByRole("tab", { name: "死信投递", exact: true }).click();
  expect((await outboxRequest).status()).toBe(200);
  await expect(page).toHaveURL(/tab=outbox/);
  await expect(page).not.toHaveURL(/kind=|cursor=|pageSize=10/);
  await expect(
    row(page, `${item.outbox[0]!.outboxEventId}:${item.outbox[0]!.subscriber}`),
  ).toContainText(item.outbox[0]!.subscriber);
  const outboxPage = response(page, "GET", "outbox-deliveries");
  await page.goto(`/sys/flow-ops?tab=outbox&subscriber=${item.outbox[0]!.subscriber}&pageSize=10`);
  const deliveryIds = (await (await outboxPage).json()).data.items.map(
    (value: { outboxEventId: string }) => value.outboxEventId,
  );
  const nextOutbox = response(page, "GET", "outbox-deliveries");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  deliveryIds.push(
    ...(await (await nextOutbox).json()).data.items.map(
      (value: { outboxEventId: string }) => value.outboxEventId,
    ),
  );
  expect(new Set(deliveryIds)).toEqual(new Set(item.outbox.map((value) => value.outboxEventId)));
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await shot(page, "flow-ops-02-dead-outbox");
  const inboxRequest = response(page, "GET", "webhook-events");
  await page.goto(
    "/sys/flow-ops?tab=webhooks&provider=wechatpay&eventType=TRANSACTION.SUCCESS&limit=10",
  );
  const inbox = await inboxRequest;
  expect(inbox.status()).toBe(200);
  const inboxData = (await inbox.json()).data,
    ids = inboxData.items.map((value: { webhookEventId: string }) => value.webhookEventId),
    nextInbox = response(page, "GET", "webhook-events");
  await expect(page.getByText("金额（分）：100", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const second = (await (await nextInbox).json()).data;
  ids.push(...second.items.map((value: { webhookEventId: string }) => value.webhookEventId));
  expect(new Set(ids)).toEqual(new Set(item.webhooks.map((value) => value.webhookEventId)));
  expect(ids).toHaveLength(12);
  await expect(page).toHaveURL(/cursor=/);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.reload();
  await expect(page).toHaveURL(/provider=wechatpay/);
  await shot(page, "flow-ops-03-webhook-inbox");
  await expect(page.getByRole("tab", { name: /媒体/ })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
test("W223 四个恢复动作真实确认/同目标409刷新，成功只按服务端状态", async ({ page }) => {
  const item = fixture(),
    errors = recordErrors(page),
    pageErrors: string[] = [],
    consoleErrors: { text: string; url: string }[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  await page.goto("/sys/flow-ops?kind=ops.retention");
  const rescheduled = item.timers[0]!,
    cancelled = item.timers[1]!,
    conflict = item.timers[2]!;
  await observeActionRequests(page, [
    `/api/v1/admin/timers/${rescheduled.timerId}/reschedule`,
    `/api/v1/admin/timers/${cancelled.timerId}/cancel`,
    `/api/v1/admin/timers/${conflict.timerId}/reschedule`,
    `/api/v1/admin/outbox-events/${item.outbox[0]!.outboxEventId}/retry`,
    `/api/v1/admin/webhook-events/${item.webhooks[0]!.webhookEventId}/retry`,
  ]);
  const before = await auditCount(page, "timer", rescheduled.timerId);
  await row(page, rescheduled.timerId)
    .getByRole("button", { name: "重新排期", exact: true })
    .click();
  const dialog = await ordinaryConfirm(page);
  await expect(dialog).toContainText("不修改到期时间");
  await expect(dialog).toContainText(appDateTimeFormat.dateTimeFull(rescheduled.fireAt));
  await expect(dialog).not.toContainText(rescheduled.fireAt);
  await shot(page, "flow-ops-04-confirm-reschedule");
  const rescheduleResponse = response(page, "POST", `timers/${rescheduled.timerId}/reschedule`);
  await dialog.getByRole("button", { name: "确认操作", exact: true }).click();
  const restored = await rescheduleResponse;
  expect(restored.status()).toBe(200);
  await expectWireBody(page, new URL(restored.url()).pathname, {});
  expect((await restored.json()).data).toMatchObject({
    status: "scheduled",
    fireAt: rescheduled.fireAt,
    attempts: 0,
    dispatchNo: 3,
    retryAt: null,
    actions: [],
  });
  await expect(row(page, rescheduled.timerId)).toHaveCount(0);
  expect(await auditCount(page, "timer", rescheduled.timerId)).toBe(before + 1);
  await row(page, cancelled.timerId)
    .getByRole("button", { name: "标记为不再需要", exact: true })
    .click();
  await page.getByLabel("原因（必填）").fill("太短");
  await page.getByRole("button", { name: "继续确认", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("原因须为 5–200 字");
  await page.getByLabel("原因（必填）").fill("隔离验收取消原因");
  await ordinaryConfirm(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row(page, cancelled.timerId)).toBeVisible();
  await row(page, cancelled.timerId)
    .getByRole("button", { name: "标记为不再需要", exact: true })
    .click();
  await page.getByLabel("原因（必填）").fill("隔离验收取消原因");
  await ordinaryConfirm(page);
  const cancelResponse = response(page, "POST", `timers/${cancelled.timerId}/cancel`);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  const cancelledResult = await cancelResponse;
  expect(cancelledResult.status()).toBe(200);
  await expectWireBody(page, new URL(cancelledResult.url()).pathname, {
    reason: "隔离验收取消原因",
  });
  expect((await cancelledResult.json()).data).toMatchObject({
    status: "cancelled",
    fireAt: cancelled.fireAt,
    attempts: 5,
    dispatchNo: 3,
  });
  await expect(row(page, cancelled.timerId)).toHaveCount(0);
  await row(page, conflict.timerId).getByRole("button", { name: "重新排期", exact: true }).click();
  await ordinaryConfirm(page);
  const race = await page.request.post(`/api/v1/admin/timers/${conflict.timerId}/cancel`, {
    headers: {
      Origin: liveContext().origin,
      "X-LYX-Admin": "1",
      "Idempotency-Key": "w223-race-cancel",
    },
    data: { reason: "另一个操作窗口取消" },
  });
  expect(race.status()).toBe(200);
  const conflictResponse = response(page, "POST", `timers/${conflict.timerId}/reschedule`);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  const rejected = await conflictResponse;
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).error).toBe("STATE_NOT_ALLOWED");
  await expectWireBody(page, new URL(rejected.url()).pathname, {});
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("记录状态已变化，列表已刷新，请重新核对后操作", { exact: true }),
  ).toBeVisible();
  await expect(row(page, conflict.timerId)).toHaveCount(0);
  await shot(page, "flow-ops-05-state-conflict");
  await page.getByRole("tab", { name: "死信投递", exact: true }).click();
  const delivery = item.outbox[0]!;
  await row(page, `${delivery.outboxEventId}:${delivery.subscriber}`)
    .getByRole("button", { name: "重投死信", exact: true })
    .click();
  await page.getByLabel("备注（可选）").fill("隔离验收重投");
  await ordinaryConfirm(page);
  const deliveryResponse = response(page, "POST", `outbox-events/${delivery.outboxEventId}/retry`);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  const retried = await deliveryResponse;
  expect(retried.status()).toBe(200);
  await expectWireBody(page, new URL(retried.url()).pathname, {
    subscriber: delivery.subscriber,
    note: "隔离验收重投",
  });
  expect((await retried.json()).data).toMatchObject({
    status: "retry",
    subscriber: delivery.subscriber,
    attempts: 0,
    dispatchNo: 3,
    actions: [],
  });
  await expect(row(page, `${delivery.outboxEventId}:${delivery.subscriber}`)).toHaveCount(0);
  await page.getByRole("tab", { name: "回调收件箱", exact: true }).click();
  const callback = item.webhooks[0]!;
  await row(page, callback.webhookEventId)
    .getByRole("button", { name: "重置死信回调", exact: true })
    .click();
  await ordinaryConfirm(page);
  const callbackResponse = response(
    page,
    "POST",
    `webhook-events/${callback.webhookEventId}/retry`,
  );
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  const reset = await callbackResponse;
  expect(reset.status()).toBe(200);
  await expectWireBody(page, new URL(reset.url()).pathname, {});
  expect((await reset.json()).data).toMatchObject({
    processState: "received",
    attempts: 0,
    actions: [],
  });
  await expect(row(page, callback.webhookEventId)).toHaveCount(0);
  const posts = await wirePosts(page);
  expect(posts).toHaveLength(5);
  expect(new Set(posts.map((post) => post.key)).size).toBe(5);
  // 唯一刻意409必须与实际POST/status/symbol及console资源地址精确配对；其它错误仍失败。
  const resourceError =
    "Failed to load resource: the server responded with a status of 409 (Conflict)";
  expect(rejected.request().method()).toBe("POST");
  expect(consoleErrors).toEqual([{ text: resourceError, url: rejected.url() }]);
  expect(errors).toEqual([resourceError]);
  expect(pageErrors).toEqual([]);
});
