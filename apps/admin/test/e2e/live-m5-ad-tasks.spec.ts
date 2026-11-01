import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type Locator, type Route } from "@playwright/test";
import { AdTaskDetailSchema, OpenWorkSummarySchema } from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
type Fixture = {
  scope: { runId: string; adIds: string[]; editorId: string };
  ads: { adId: string; adNo: string }[];
  editor: { name: string; phone: string; password: string; recoveryCode: string };
  video: { path: string; sha256: string; size: number; durationMs: number };
};
function fixture() {
  return (liveContext().fixtures as { fixtures: { w514: Fixture } }).fixtures.w514;
}
async function getAd(page: Page, adId: string) {
  const response = await page.request.get(`/api/v1/admin/ads/${adId}`);
  expect(response.status()).toBe(200);
  return AdTaskDetailSchema.parse((await response.json()).data);
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  mkdirSync("dist/e2e-shots", { recursive: true });
  // The original 10s expectation budget, exact bytes and no masks; retain both raw frames.
  const deadline = Date.now() + 10_000;
  let pair = 0,
    stable: Buffer | undefined;
  await expect
    .poll(
      async () => {
        const first = await page.screenshot({
          path: `dist/e2e-shots/${name}-pair-first.png`,
          animations: "disabled",
          timeout: Math.max(1, deadline - Date.now()),
        });
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
        const second = await page.screenshot({
          path: `dist/e2e-shots/${name}-pair-second.png`,
          animations: "disabled",
          timeout: Math.max(1, deadline - Date.now()),
        });
        if (++pair === 1) {
          writeFileSync(`dist/e2e-shots/${name}-initial-first.png`, first);
          writeFileSync(`dist/e2e-shots/${name}-initial-second.png`, second);
        }
        if (second.equals(first)) {
          stable = second;
          return true;
        }
        return false;
      },
      { timeout: 10_000, intervals: [100], message: `${name}两帧稳定` },
    )
    .toBe(true);
  if (!stable) throw new Error("未取得两帧一致的截图");
  writeFileSync(`dist/e2e-shots/${name}.png`, stable);
}
async function confirm(dialog: Locator) {
  await dialog
    .getByRole("checkbox", { name: "我已核对当前广告、版本和本次操作", exact: true })
    .check();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
}
test("广告单工作台：真实候选/扣减、独立编辑上传检查/版本/推送、免费代录、退回与取消申请", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  const f = fixture(),
    errors = recordErrors(page),
    first = f.ads[0]!,
    second = f.ads[1]!,
    third = f.ads[2]!;
  expect(f.video.durationMs).toBeGreaterThanOrEqual(2950);
  expect(f.video.durationMs).toBeLessThanOrEqual(3050);
  const bytes = readFileSync(f.video.path);
  expect(bytes.length).toBe(f.video.size);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.video.sha256);
  const url = (id: string, tab = "all") =>
    `/delivery/ad-tasks?tab=${tab}&q=${f.scope.runId}&id=${id}`;
  await page.goto(url(first.adId));
  await expect(page.getByRole("heading", { name: "广告制作任务", exact: true })).toBeVisible();
  await expect(page.locator("[data-queue-item]")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "制作需求", exact: true })).toBeVisible();
  await shot(page, "w514-01-queue-detail");
  await page.getByRole("button", { name: "指派剪辑师", exact: true }).click();
  const assign = page.getByRole("dialog", { name: "指派剪辑师", exact: true });
  await assign.getByRole("combobox", { name: "剪辑师", exact: true }).click();
  await page.getByTitle(new RegExp(f.editor.name)).click();
  await expect(assign).toContainText("广告在办");
  await shot(page, "w514-02-assignment-load");
  let assigns = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/ads/${first.adId}/assign`))
      assigns++;
  });
  await assign
    .getByRole("checkbox", { name: "我已核对当前广告、版本和本次操作", exact: true })
    .check();
  await assign.getByRole("button", { name: "确认", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(assign).toHaveCount(0);
  expect(assigns).toBe(1);
  const assigned = await getAd(page, first.adId);
  expect(assigned.editor?.staffId).toBe(f.scope.editorId);
  expect(assigned.isCaptured).toBe(true);
  const workResponse = await page.request.get(`/api/v1/admin/staff/${f.scope.editorId}/open-work`);
  expect(workResponse.status()).toBe(200);
  const work = OpenWorkSummarySchema.parse((await workResponse.json()).data);
  expect(work.total).toBe(1);
  expect(work.bySource).toEqual([
    {
      source: "ad_editor",
      subjectType: "ad",
      count: 1,
      samples: [{ subjectId: first.adId, label: first.adNo }],
    },
  ]);
  const editorContext = await browser.newContext({
    baseURL: liveContext().origin,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  try {
    const editor = await editorContext.newPage(),
      editorErrors = recordErrors(editor);
    editor.setDefaultTimeout(10_000);
    await editor.goto(`/login?redirect=${encodeURIComponent(url(first.adId))}`);
    await editor.getByLabel("手机号", { exact: true }).fill(f.editor.phone);
    await editor.getByLabel("密码", { exact: true }).fill(f.editor.password);
    await editor.getByRole("button", { name: "下一步", exact: true }).click();
    await editor.getByRole("radio", { name: "恢复码", exact: true }).check();
    await editor.getByRole("textbox", { name: "恢复码", exact: true }).fill(f.editor.recoveryCode);
    await editor.getByRole("button", { name: "登录", exact: true }).click();
    await expect(editor.getByRole("button", { name: "用户菜单" })).toContainText(f.editor.name);
    expect((await editor.request.get(`/api/v1/admin/ads/${second.adId}`)).status()).toBe(404);
    await expect(editor.getByRole("button", { name: "指派剪辑师", exact: true })).toHaveCount(0);
    // A real storage POST is held at a barrier; closing the modal must discard that upload intent.
    let releaseStorage!: () => void, storageReached!: () => void;
    const storageGate = new Promise<void>((done) => {
        releaseStorage = done;
      }),
      reached = new Promise<void>((done) => {
        storageReached = done;
      });
    const storageRoute = async (route: Route) => {
      const request = route.request();
      if (
        request.method() === "POST" &&
        !new URL(request.url()).pathname.startsWith("/api/v1/") &&
        ["xhr", "fetch"].includes(request.resourceType())
      ) {
        storageReached();
        await storageGate;
        await route.continue().catch(() => {
          /* The original XHR was explicitly aborted by modal teardown. */
        });
      } else await route.continue();
    };
    await editor.route("**/*", storageRoute);
    await editor.getByRole("button", { name: "上传广告版本", exact: true }).click();
    const abandoned = editor.getByRole("dialog", { name: "上传广告版本", exact: true });
    try {
      await abandoned.locator('input[type="file"]').setInputFiles({
        name: `w514-abandoned-${f.scope.runId}.mp4`,
        mimeType: "video/mp4",
        buffer: bytes,
      });
      await reached;
      await abandoned.locator(".ant-modal-close").click();
      await expect(abandoned).toHaveCount(0);
    } finally {
      releaseStorage();
      await editor.unroute("**/*", storageRoute);
    }
    expect((await getAd(page, first.adId)).versions).toHaveLength(0);
    await editor.getByRole("button", { name: "上传广告版本", exact: true }).click();
    const upload = editor.getByRole("dialog", { name: "上传广告版本", exact: true });
    await expect(
      upload.getByText("文件已入库；登记时仍须通过广告媒体检查。", { exact: true }),
    ).toHaveCount(0);
    await upload
      .locator('input[type="file"]')
      .setInputFiles({ name: `w514-${f.scope.runId}.mp4`, mimeType: "video/mp4", buffer: bytes });
    await expect(
      upload.getByText("文件已入库；登记时仍须通过广告媒体检查。", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await upload
      .getByRole("textbox", { name: "分段（可选，每行：开始毫秒,结束毫秒,广告标签）", exact: true })
      .fill("0,3000,广告");
    await expect(upload.getByText("媒体检查通过，可登记版本", { exact: true })).toBeVisible();
    await shot(editor, "w514-03-upload-version");
    await confirm(upload);
    await expect(upload).toHaveCount(0);
    const registered = await getAd(page, first.adId);
    expect(registered.versions).toHaveLength(1);
    expect(registered.versions[0]!.width).toBe(1080);
    expect(registered.versions[0]!.height).toBe(1920);
    expect(registered.versions[0]!.production?.pipelineState).toBe("ready");
    expect(registered.versions[0]!.pushedAt).toBeNull();
    // The local operator records evidence; this test does not claim external WeCom delivery.
    await page.reload();
    await page.getByRole("button", { name: "登记企业微信已发送", exact: true }).click();
    const sent = page.getByRole("dialog", { name: "登记企业微信已发送", exact: true });
    await confirm(sent);
    await expect(sent).toHaveCount(0);
    await editor.reload();
    await editor.getByRole("button", { name: "推送给商家", exact: true }).click();
    const push = editor.getByRole("dialog", { name: "推送给商家", exact: true });
    await push.getByRole("checkbox", { name: "包含已登记的企业微信发送事实", exact: true }).check();
    await shot(editor, "w514-04-push-confirm");
    await confirm(push);
    await expect(push).toHaveCount(0);
    const pushed = await getAd(page, first.adId);
    expect(pushed.status).toBe("pending_confirm");
    expect(pushed.versions[0]!.offlineSentAt).not.toBeNull();
    expect(pushed.versions[0]!.previewChannels).toContain("wecom");
    await page.goto(url(first.adId));
    await page.getByRole("button", { name: "催办商家确认", exact: true }).click();
    const remind = page.getByRole("dialog", { name: "催办商家确认", exact: true });
    await confirm(remind);
    await expect(remind).toHaveCount(0);
    await expect(page.getByRole("button", { name: "催办商家确认", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "代录免费修改", exact: true }).click();
    const change = page.getByRole("dialog", { name: "代录免费修改", exact: true });
    await change.getByRole("textbox", { name: "修改意见", exact: true }).fill("请调整广告字幕大小");
    const acknowledgement = change.getByRole("checkbox", {
      name: "我已核对当前广告、版本和本次操作",
      exact: true,
    });
    await acknowledgement.check();
    await change.getByRole("textbox", { name: "修改意见", exact: true }).fill("请调整广告字幕颜色");
    await expect(acknowledgement).not.toBeChecked();
    await change.getByRole("textbox", { name: "修改意见", exact: true }).fill("请调整广告字幕大小");
    await expect(acknowledgement).not.toBeChecked();
    await shot(page, "w514-05-free-revision");
    await confirm(change);
    await expect(change).toHaveCount(0);
    const revised = await getAd(page, first.adId);
    expect(revised.status).toBe("revising");
    expect(revised.revisions).toHaveLength(1);
    expect(revised.revisions[0]!.source).toBe("staff_on_behalf");
    await page.goto(url(second.adId));
    await page.getByRole("button", { name: "申请取消广告", exact: true }).click();
    const cancel = page.getByRole("dialog", { name: "申请取消广告", exact: true });
    await cancel
      .getByRole("textbox", { name: "取消说明（至少5字）", exact: true })
      .fill("商家申请取消广告制作");
    await expect(cancel).toContainText("本次预览退回");
    await shot(page, "w514-06-cancel-preview");
    await confirm(cancel);
    await expect(cancel).toHaveCount(0);
    const requested = await getAd(page, second.adId);
    expect(requested.openCancelRequest).not.toBeNull();
    expect(requested.status).not.toBe("cancelled");
    await shot(page, "w514-07-cancel-request");
    await page.goto(url(third.adId));
    await page.getByRole("button", { name: "退回补充", exact: true }).click();
    const returned = page.getByRole("dialog", { name: "退回补充", exact: true });
    await returned
      .getByRole("textbox", { name: "退回原因", exact: true })
      .fill("请补充门店参考素材");
    await confirm(returned);
    await expect(returned).toHaveCount(0);
    expect((await getAd(page, third.adId)).returnReason).toBe("请补充门店参考素材");
    await page.goto(`/delivery/ad-tasks?q=NO-MATCH-${f.scope.runId}`);
    await expect(
      page.getByRole("region", { name: "广告制作任务的队列", exact: true }),
    ).toContainText("没有符合条件的事项");
    await expect(page.locator("[data-queue-item]")).toHaveCount(0);
    await shot(page, "w514-08-empty");
    expect(editorErrors).toEqual([]);
  } finally {
    await editorContext.close();
  }
  expect(errors).toEqual([]);
});
