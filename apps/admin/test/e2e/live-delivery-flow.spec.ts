import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { orderShot } from "./live-order-fixture";
import {
  apiData,
  attachKnownMedia,
  deliveryFixture,
  deliveryVideo,
  knownFile,
  managerLogin,
} from "./live-delivery-fixture";
async function passChecks(dialog: Locator) {
  const checks = dialog.locator(".lyx-checklist").getByRole("checkbox");
  expect(await checks.count()).toBeGreaterThan(0);
  for (const check of await checks.all()) await check.check();
}
test("交付真实主路径：分配/方案确认/两人样片质检/保存留证/两集成片及包质检", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const f = deliveryFixture(),
    errors = recordErrors(page),
    files = attachKnownMedia(page),
    manager = managerLogin();
  const context = await browser.newContext({
    baseURL: liveContext().origin,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  try {
    const managerPage = await context.newPage(),
      managerErrors = recordErrors(managerPage);
    await page.goto(`/delivery/tickets?q=制作演练-${f.scope.runId}`);
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(2);
    await table.getByRole("button", { name: "分配", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "分配交付经理", exact: true });
    await assign.getByRole("combobox", { name: "交付经理", exact: true }).click();
    await page.getByTitle(manager.name, { exact: true }).click();
    await assign.getByRole("button", { name: "确认分配", exact: true }).click();
    await expect(assign).toHaveCount(0);
    await table.getByRole("link", { name: f.ticketNo, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/delivery/tickets/${f.ticketNo}\\?tab=plan$`));
    await expect(
      page.getByRole("heading", { name: `工单 ${f.ticketNo}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("当前步骤", { exact: true })).toBeVisible();
    await orderShot(page, "delivery-01-detail");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: `工单 ${f.ticketNo}`, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "配置方案", exact: true }).click();
    const plan = page.getByRole("dialog", { name: "配置交付方案", exact: true });
    await plan
      .getByRole("textbox", { name: "补充说明", exact: true })
      .fill("突出门店主推服务，保持清晰字幕与自然节奏");
    await plan.getByLabel("约定上线日", { exact: true }).fill(f.launchDate);
    await plan.getByLabel("预计交付日", { exact: true }).fill(f.deliveryDate);
    await expect(plan).toContainText(f.accountName);
    await orderShot(page, "delivery-02-plan-drawer");
    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith(`/delivery-plans/${f.planId}/draft`))
        saves++;
    });
    await plan.getByRole("button", { name: "保存方案", exact: true }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(plan).toHaveCount(0);
    expect(saves).toBe(1);
    await page.getByRole("button", { name: "推送方案", exact: true }).click();
    const pushPlan = page.getByRole("dialog", { name: "推送交付方案", exact: true });
    await pushPlan.getByRole("checkbox").check();
    await pushPlan.getByRole("button", { name: "确认推送", exact: true }).click();
    await expect(pushPlan).toHaveCount(0);
    await expect(page.locator('.lyx-production-steps [aria-current="step"]')).toContainText(
      "方案确认",
    );
    await apiData(
      page.request,
      `/api/v1/m/delivery-plans/${f.planId}/confirm`,
      { versionNo: 1 },
      f.ownerHeaders,
    );
    await page.reload();
    await page.getByRole("tab", { name: "样片与质检", exact: true }).click();
    await expect(page.locator('.lyx-production-steps [aria-current="step"]')).toContainText(
      "样片制作",
    );
    // 老经理第二个原始恢复码；不重新激活、改角色或覆盖旧 PR1 的第一个码。
    await managerPage.goto(
      `/login?redirect=${encodeURIComponent(`/delivery/tickets/${f.ticketNo}?tab=sample`)}`,
    );
    await managerPage.getByLabel("手机号", { exact: true }).fill(manager.phone);
    await managerPage.getByLabel("密码", { exact: true }).fill(manager.password);
    await managerPage.getByRole("button", { name: "下一步", exact: true }).click();
    await managerPage.getByRole("radio", { name: "恢复码", exact: true }).check();
    await managerPage
      .getByRole("textbox", { name: "恢复码", exact: true })
      .fill(manager.recoveryCode);
    await managerPage.getByRole("button", { name: "登录", exact: true }).click();
    await expect(managerPage.getByRole("button", { name: "用户菜单" })).toContainText(manager.name);
    for (const artifact of ["unknown_sample", "sample"] as const) {
      await page.getByRole("button", { name: "上传样片", exact: true }).click();
      const upload = page.getByRole("dialog", { name: "上传样片", exact: true });
      const completed = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.status() === 200 &&
          /\/api\/v1\/admin\/files\/[^/]+\/complete$/.test(new URL(response.url()).pathname),
      );
      await upload.locator('input[type="file"]').setInputFiles(knownFile(artifact));
      await completed;
      await files.settled();
      await expect(upload.getByRole("button", { name: "登记样片", exact: true })).toBeEnabled({
        timeout: 30_000,
      });
      await files.settled();
      if (artifact === "sample") await orderShot(page, "delivery-03-sample-upload");
      await upload.getByRole("button", { name: "登记样片", exact: true }).click();
      await expect(upload).toHaveCount(0);
      const ticket = await apiData(
        page.request,
        `/api/v1/admin/delivery-tickets/${f.scope.ticketId}`,
      );
      expect(ticket.currentSample.durationMs).toBe(
        artifact === "sample" ? deliveryVideo().manifest.probe.durationMs : null,
      );
      if (artifact === "unknown_sample") {
        const templates = await apiData(
            managerPage.request,
            "/api/v1/admin/checklist-templates?code=qc.sample&status=active",
          ),
          template = templates.items.find((t: { code: string }) => t.code === "qc.sample");
        const negative = await managerPage.request.post(
          `/api/v1/admin/samples/${ticket.currentSample.sampleId}/inspect`,
          {
            data: {
              checklistVersionNo: template.versionNo,
              results: template.items.map((i: { key: string }) => ({ key: i.key, result: "pass" })),
            },
            headers: {
              "Idempotency-Key": crypto.randomUUID(),
              "X-LYX-Admin": "1",
              Origin: liveContext().origin,
              "X-Client-Version": "1.0.0",
            },
          },
        );
        expect(negative.status()).toBe(409);
        expect((await negative.json()).error).toBe("PRODUCTION_NOT_READY");
        const unchanged = await apiData(
          page.request,
          `/api/v1/admin/delivery-tickets/${f.scope.ticketId}`,
        );
        expect(unchanged.currentSample.qc).toBeNull();
        expect(unchanged.step).toBe("sample_making");
        console.info(
          "W119 unknown metadata：真实 QC 409 PRODUCTION_NOT_READY，currentSample.qc=null、step=sample_making 保持；五类业务零增另由真库桥目标断言",
        );
      }
    }
    await expect(page.getByRole("button", { name: "样片质检", exact: true })).toHaveCount(0);
    await managerPage.reload();
    await managerPage.getByRole("button", { name: "样片质检", exact: true }).click();
    const sampleQc = managerPage.getByRole("dialog", { name: "样片质检", exact: true });
    await expect(sampleQc.locator(".lyx-checklist")).toBeVisible();
    await passChecks(sampleQc);
    await orderShot(managerPage, "delivery-04-sample-qc");
    await sampleQc.getByRole("button", { name: "提交质检", exact: true }).click();
    await expect(sampleQc).toHaveCount(0);
    await managerPage.getByRole("button", { name: "推送样片", exact: true }).click();
    const push = managerPage.getByRole("dialog", { name: "推送样片", exact: true });
    await expect(push.getByRole("checkbox")).toHaveCount(1);
    await push.getByRole("checkbox").check();
    await push.getByRole("button", { name: "确认推送", exact: true }).click();
    await expect(push).toHaveCount(0);
    await expect(managerPage.locator('.lyx-production-steps [aria-current="step"]')).toContainText(
      "样片确认",
    );
    const current = await apiData(
        page.request,
        `/api/v1/admin/delivery-tickets/${f.scope.ticketId}`,
      ),
      sample = current.currentSample;
    const save = await page.request.post(`/api/v1/m/samples/${sample.sampleId}/download-urls`, {
      data: {},
      headers: f.ownerHeaders,
    });
    expect(save.status()).toBe(200);
    expect(save.headers()["cache-control"]).toBe("no-store");
    const download = (await save.json()).data;
    expect(new URL(download.url).origin).toBe("http://127.0.0.1:9100");
    expect(new URL(download.url).searchParams.get("X-Amz-Expires")).toBe("900");
    const actual = await fetch(download.url);
    expect(actual.status).toBe(200);
    const sampleBytes = Buffer.from(await actual.arrayBuffer());
    expect(sampleBytes.byteLength).toBe(Number(download.sizeBytes));
    expect(createHash("sha256").update(sampleBytes).digest("hex")).not.toBe(
      deliveryVideo().manifest.sha256,
    );
    await apiData(
      page.request,
      `/api/v1/m/samples/${sample.sampleId}/confirm`,
      { versionNo: sample.versionNo, viewedVia: "album", hasViewed: true },
      f.ownerHeaders,
    );
    await page.reload();
    await page.getByRole("tab", { name: "成片与发布", exact: true }).click();
    await expect(page.locator('.lyx-production-steps [aria-current="step"]')).toContainText(
      "批量合成",
    );
    await page.getByRole("button", { name: "登记成片", exact: true }).click();
    const episodes = page.getByRole("dialog", { name: "登记成片", exact: true });
    const batchContext = liveContext().fixtures as {
      w302BridgeOrigin: string;
      fixtures: {
        w302: {
          video: { path: string; sha256: string; size: number; probe: { durationMs: number } };
        };
      };
    };
    const bridgeOrigin = new URL(batchContext.w302BridgeOrigin);
    expect(bridgeOrigin.protocol).toBe("http:");
    expect(bridgeOrigin.hostname).toBe("127.0.0.1");
    const rawVideo = readFileSync(batchContext.fixtures.w302.video.path);
    expect(batchContext.fixtures.w302.video.probe.durationMs).toBeGreaterThanOrEqual(20_000);
    expect(batchContext.fixtures.w302.video.probe.durationMs).toBeLessThan(1_200_000);
    expect(rawVideo.length).toBe(batchContext.fixtures.w302.video.size);
    expect(createHash("sha256").update(rawVideo).digest("hex")).toBe(
      batchContext.fixtures.w302.video.sha256,
    );
    for (const targetPage of [page, managerPage])
      for (const hostname of [
        "test-media-1250000000.cos.ap-test-1.myqcloud.com",
        "fake-storage.invalid",
      ])
        await targetPage.route(`https://${hostname}/**`, async (route) => {
          const original = new URL(route.request().url());
          const target = new URL(batchContext.w302BridgeOrigin);
          target.pathname =
            hostname === "fake-storage.invalid"
              ? `/fake-read${original.pathname}`
              : original.pathname;
          target.search = original.search;
          await route.fulfill({ response: await route.fetch({ url: target.toString() }) });
        });
    await episodes.getByLabel("选择成片文件", { exact: true }).setInputFiles(
      ["final_1", "final_2"].map((artifact) => ({
        ...knownFile(artifact as "final_1" | "final_2"),
        buffer: rawVideo,
      })),
    );
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/admin/upload-batches",
    );
    await episodes.getByRole("button", { name: "创建批次并核对", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(200);
    const batch = (await createdResponse.json()).data;
    expect(batch.expectedCount).toBe(2);
    expect(batch.items).toHaveLength(2);
    for (const [index, artifact] of ["final_1", "final_2"].entries()) {
      const filename = knownFile(artifact as "final_1" | "final_2").name;
      const input = episodes.getByLabel(`文件 ${filename} 集号`, { exact: true });
      const number = String(index + 1);
      if ((await input.inputValue()) !== number) {
        await input.fill(number);
        await episodes
          .locator("[data-batch-item]")
          .filter({ hasText: filename })
          .getByRole("button", { name: "修改集号", exact: true })
          .click();
      }
    }
    if (batch.coverage.needsSequenceConfirm)
      await episodes
        .getByRole("checkbox", { name: "我已逐集核对，确认采用服务器给出的顺序建议" })
        .check();
    await episodes.getByRole("button", { name: "确认匹配并开始上传", exact: true }).click();
    await expect(episodes.getByRole("heading", { name: "可登记", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const checked = await apiData(
      page.request,
      `/api/v1/admin/upload-batches/${batch.uploadBatchId}`,
    );
    expect(checked.state).toBe("ready");
    expect(checked.counts.checked).toBe(2);
    expect(checked.coverage.missingEpisodeNos).toEqual([]);
    await orderShot(page, "delivery-05-episode-register");
    await episodes.getByRole("button", { name: "登记成片文件", exact: true }).click();
    await expect(episodes).toHaveCount(0);
    await managerPage.goto(`/delivery/tickets/${f.ticketNo}?tab=episodes`);
    await managerPage.getByRole("button", { name: "逐集质检", exact: true }).click();
    const episodeQc = managerPage.getByRole("dialog", { name: "逐集质检", exact: true });
    await expect(episodeQc.locator(".lyx-checklist")).toBeVisible();
    await passChecks(episodeQc);
    await episodeQc.getByRole("combobox", { name: "单集例外", exact: true }).click();
    await managerPage.getByTitle("第 2 集", { exact: true }).click();
    await episodeQc.getByRole("heading", { name: "默认质检结论", exact: true }).click();
    await expect(episodeQc.locator(".lyx-checklist")).toHaveCount(2);
    await expect(episodeQc.getByRole("button", { name: "提交质检", exact: true })).toBeDisabled();
    await passChecks(episodeQc);
    await orderShot(managerPage, "delivery-06-episode-qc");
    await episodeQc.getByRole("button", { name: "提交质检", exact: true }).click();
    await expect(episodeQc).toHaveCount(0);
    await managerPage.getByRole("button", { name: "成片包质检", exact: true }).click();
    const packageQc = managerPage.getByRole("dialog", { name: "成片包质检", exact: true });
    await expect(packageQc.locator(".lyx-checklist")).toBeVisible();
    await passChecks(packageQc);
    await orderShot(managerPage, "delivery-07-package-qc");
    await packageQc.getByRole("button", { name: "提交质检", exact: true }).click();
    await expect(packageQc).toHaveCount(0);
    await expect(managerPage.locator('.lyx-production-steps [aria-current="step"]')).toContainText(
      "成片交付",
    );
    const final = await apiData(
      managerPage.request,
      `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/episode-outputs`,
    );
    expect(final.currentPassedCount).toBe(2);
    expect(final.packageQc.verdict).toBe("pass");
    expect(
      final.episodes.map(
        (e: { current: { durationMs: number; qc: { inspectedBy: { staffId: string } } } }) => [
          e.current.durationMs,
          e.current.qc.inspectedBy.staffId,
        ],
      ),
    ).toEqual([
      [batchContext.fixtures.w302.video.probe.durationMs, manager.id],
      [batchContext.fixtures.w302.video.probe.durationMs, manager.id],
    ]);
    await expect(managerPage.getByRole("button", { name: "推送成片包", exact: true })).toHaveCount(
      0,
    );
    await orderShot(managerPage, "delivery-08-delivering");
    await noHorizontalScroll(page, "两集登记完成");
    expect(errors).toEqual([]);
    expect(managerErrors).toEqual([]);
  } finally {
    await context.close();
    await files.cleanup();
  }
});
