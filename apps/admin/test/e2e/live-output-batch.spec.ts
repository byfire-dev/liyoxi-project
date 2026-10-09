import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { EpisodeGridSchema, type UploadBatchDetail } from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { orderShot } from "./live-order-fixture";

interface MediaFixture {
  path: string;
  size: number;
  sha256: string;
}
interface OutputFixture {
  scope: {
    runId: string;
    name: string;
    prefix: string;
    ticketId: string;
    itemId: string;
    uploaderId: string;
  };
  ticketNo: string;
  bridgeOrigin: string;
  video: MediaFixture;
  resumeVideo: MediaFixture;
}
function fixture(): OutputFixture {
  const context = liveContext();
  const f = (context.fixtures as { fixtures: Record<string, OutputFixture> }).fixtures.w302;
  const origin = f && new URL(f.bridgeOrigin);
  if (
    !f ||
    !/^[a-f0-9]{16}$/.test(f.scope.runId) ||
    f.scope.name !== `lyx_test_admin_live_${f.scope.runId}` ||
    f.scope.prefix !== `lyx:test:admin_live_${f.scope.runId}:` ||
    origin?.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.pathname !== "/"
  )
    throw new Error("Missing exact owned W302 fixture / Provider bridge");
  return f;
}
function verifiedBytes(file: MediaFixture) {
  const bytes = readFileSync(file.path);
  if (
    bytes.length !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new Error("Actual fixture bytes differ from recorded video evidence");
  return bytes;
}
function video(file: MediaFixture, name: string) {
  return { name, mimeType: "video/mp4", buffer: verifiedBytes(file) };
}
function wholeBatchFiles(file: MediaFixture, runId: string) {
  verifiedBytes(file);
  const parent = dirname(file.path);
  if (!parent.endsWith(`/admin-live-${runId}`)) throw new Error("Unowned batch selection");
  const directory = join(parent, "batch-selection");
  mkdirSync(directory, { mode: 0o700 });
  return Array.from({ length: 20 }, (_, i) => {
    const path = join(directory, `clip-${String.fromCharCode(65 + i)}.mp4`);
    linkSync(file.path, path);
    return path;
  });
}
async function batchData(page: Page, id: string): Promise<UploadBatchDetail> {
  const response = await page.request.get(`/api/v1/admin/upload-batches/${id}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return (await response.json()).data as UploadBatchDetail;
}
async function create(page: Page, dialog: Locator) {
  const result = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/admin/upload-batches",
  );
  await dialog.getByRole("button", { name: "创建批次并核对", exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  return (await response.json()).data as UploadBatchDetail;
}

test("真实20集批次：服务器总数/人工顺序/刷新续传/体检ready/交付消费", async ({ page }) => {
  test.setTimeout(180_000);
  const f = fixture(),
    errors = recordErrors(page);
  expect(f.resumeVideo.size).toBeGreaterThan(20 * 1024 * 1024);
  let holdParts = false;
  let release!: (continueRequest: boolean) => void;
  let held = Promise.resolve(true);
  let firstPart!: () => void;
  const firstPartStored = new Promise<void>((resolve) => {
    firstPart = resolve;
  });
  const forward = async (route: Route) => {
    const request = route.request(),
      original = new URL(request.url());
    if (
      holdParts &&
      request.method() === "PUT" &&
      Number(original.searchParams.get("partNumber")) > 1
    ) {
      if (!(await held)) {
        await route.abort("aborted").catch(() => undefined);
        return;
      }
    }
    const target = new URL(f.bridgeOrigin);
    target.pathname =
      original.hostname === "fake-storage.invalid"
        ? `/fake-read${original.pathname}`
        : original.pathname;
    target.search = original.search;
    const response = await route.fetch({ url: target.toString() });
    await route.fulfill({ response });
    if (
      request.method() === "PUT" &&
      original.searchParams.get("partNumber") === "1" &&
      response.ok()
    )
      firstPart();
  };
  const cos = "https://test-media-1250000000.cos.ap-test-1.myqcloud.com/**";
  await page.route(cos, forward);
  await page.route("https://fake-storage.invalid/**", forward);
  try {
    const me = await page.request.get("/api/v1/admin/auth/me");
    expect(me.status()).toBe(200);
    expect((await me.json()).data.staff.staffId).toBe(f.scope.uploaderId);
    await page.goto(`/delivery/tickets/${f.ticketNo}?tab=episodes`);
    await page.getByRole("button", { name: "登记成片", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "登记成片", exact: true });
    await dialog
      .getByLabel("选择成片文件", { exact: true })
      .setInputFiles(video(f.video, "第1集.mp4"));
    const missing = await create(page, dialog);
    expect(missing.expectedCount).toBe(20);
    expect(missing.scope).toBe("full");
    expect(missing.coverage.missingEpisodeNos).toEqual(Array.from({ length: 19 }, (_, i) => i + 2));
    await expect(
      dialog.getByRole("button", { name: "确认匹配并开始上传", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消此批次", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // A separate partial batch proves real cross-refresh missing-part recovery; cancel it after real ready.
    await page.getByRole("button", { name: "登记成片", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "登记成片", exact: true });
    await dialog.getByRole("radio", { name: "部分集", exact: true }).check();
    const original = video(f.resumeVideo, "第1集.mp4");
    await dialog.getByLabel("选择成片文件", { exact: true }).setInputFiles(original);
    const resumable = await create(page, dialog);
    expect(resumable.expectedCount).toBe(20);
    holdParts = true;
    held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    await dialog.getByRole("button", { name: "确认匹配并开始上传", exact: true }).click();
    await firstPartStored;
    await dialog.getByRole("button", { name: "关闭，稍后继续", exact: true }).click();
    release(false);
    holdParts = false;
    await page.reload();
    await page.getByRole("button", { name: "登记成片", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "登记成片", exact: true });
    await dialog.getByRole("combobox", { name: "找回未结束批次", exact: true }).click();
    await page.getByTitle(/上传中 · 20 集/).click();
    await dialog
      .getByRole("checkbox", { name: "续传时，我确认重新选择的是未经修改的同一原始文件" })
      .check();
    await dialog.getByLabel("续传 第1集.mp4 原始文件", { exact: true }).setInputFiles(original);
    await dialog.getByRole("button", { name: "上传所选文件 / 重试", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "可登记", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const recovered = await batchData(page, resumable.uploadBatchId);
    expect(recovered.state).toBe("ready");
    expect(recovered.counts.checked).toBe(1);
    const observations = await page.request.get(new URL("/__stats", f.bridgeOrigin).toString());
    expect(observations.status()).toBe(200);
    const seen = (await observations.json()).requests as {
      method: string;
      key: string;
      partNumber: number | null;
    }[];
    const key = resumable.items[0]!.uploadKey;
    expect(key).not.toBeNull();
    expect(
      seen.filter((r) => r.key === key && r.method === "PUT" && r.partNumber === 1),
    ).toHaveLength(1);
    expect(
      seen.some(
        (r) => r.method === "ListUploads" && r.key === `incoming/b${recovered.uploadBatchId}/`,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "取消此批次", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "登记成片", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "登记成片", exact: true });
    await dialog
      .getByLabel("选择成片文件", { exact: true })
      .setInputFiles(wholeBatchFiles(f.video, f.scope.runId));
    const batch = await create(page, dialog);
    expect(batch.expectedCount).toBe(20);
    expect(batch.aiUsage).toMatchObject({ used: false, declaredBy: f.scope.uploaderId });
    expect(batch.items).toHaveLength(20);
    expect(batch.coverage.needsSequenceConfirm).toBe(true);
    await expect(dialog.locator("[data-batch-item]")).toHaveCount(20);
    await expect(
      dialog.getByRole("button", { name: "确认匹配并开始上传", exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole("checkbox", { name: "我已逐集核对，确认采用服务器给出的顺序建议" })
      .check();
    await dialog.getByRole("button", { name: "确认匹配并开始上传", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "可登记", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const ready = await batchData(page, batch.uploadBatchId);
    expect(ready).toMatchObject({
      state: "ready",
      expectedCount: 20,
      counts: { total: 20, checked: 20 },
    });
    expect(ready.coverage).toMatchObject({
      missingEpisodeNos: [],
      duplicateEpisodeNos: [],
      unmatchedItemIds: [],
    });
    expect(new Set(ready.items.map((item) => item.episodeNo)).size).toBe(20);
    await orderShot(page, "output-batch-20-ready");
    await dialog.getByRole("button", { name: "登记成片文件", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await batchData(page, batch.uploadBatchId)).state).toBe("committed");
    const outputs = await page.request.get(
      `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/episode-outputs`,
    );
    expect(outputs.status()).toBe(200);
    const grid = EpisodeGridSchema.parse((await outputs.json()).data);
    expect(grid.totalEpisodes).toBe(20);
    expect(grid.currentPassedCount).toBe(0);
    expect(grid.episodes).toHaveLength(20);
    expect(grid.episodes.map((row) => [row.episodeNo, row.latest?.fileId])).toEqual(
      [...ready.items]
        .sort((a, b) => a.episodeNo! - b.episodeNo!)
        .map((item) => [item.episodeNo, item.fileId]),
    );
    for (const row of grid.episodes) {
      expect(row.current).toBeNull();
      expect(row.latest).toMatchObject({
        status: "uploaded",
        isCurrent: false,
        source: "manual_upload",
        production: { pipelineState: "ready", gate: "pass" },
      });
    }
    await noHorizontalScroll(page, "真实20集批次消费");
    expect(errors).toEqual([]);
  } finally {
    release?.(false);
    await page.unroute(cos, forward);
    await page.unroute("https://fake-storage.invalid/**", forward);
  }
});
