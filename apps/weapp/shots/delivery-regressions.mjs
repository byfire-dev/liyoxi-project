import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
const button = (page, label) => page.locator(".lyx-button").filter({ hasText: label });
const calls = (page) => page.evaluate(() => globalThis.__LYX_DELIVERY_CALLS__);
// 浏览器现场生成短视频，运输替身只提供同源媒体；实际使用H5 video的播放事件与控制API。
async function samplePlaybackRegression(page) {
  const runtimeErrors = [],
    captureError = (error) => runtimeErrors.push(error.message);
  page.on("pageerror", captureError);
  const control = page.locator(".sample-player__controls .lyx-button");
  const media = await page.evaluate(async () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: {
        type: "4g",
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = 90;
    canvas.height = 160;
    const stream = canvas.captureStream(12),
      chunks = [];
    const recorder = new globalThis.MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    return new Promise((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const reader = new globalThis.FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
      };
      recorder.start();
      let frame = 0;
      const draw = setInterval(() => {
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#F6F3EE";
        ctx.fillRect(0, 0, 90, 160);
        ctx.fillStyle = "#C4501B";
        ctx.fillRect(10, 20 + (frame++ % 80), 70, 40);
      }, 80);
      setTimeout(() => {
        clearInterval(draw);
        recorder.stop();
      }, 1800);
    });
  });
  await page.route("**/sample-preview.mp4", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/webm",
      body: Buffer.from(media, "base64"),
    }),
  );
  await control.click();
  await expect(page.getByText("使用移动网络播放", { exact: true })).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: fileURLToPath(new URL("./dist/png/delivery__sample-mobile.png", import.meta.url)),
  });
  await button(page, "暂不播放").click();
  await expect(page.locator("video")).toHaveCount(0);
  await control.click();
  await button(page, "继续播放样片").click();
  const video = page.locator(".sample-player video");
  await expect(video).toBeVisible();
  const frameBox = await page.locator(".sample-player__frame").boundingBox(),
    videoBox = await video.boundingBox();
  expect(frameBox.height / frameBox.width).toBeCloseTo(16 / 9, 2);
  for (const edge of ["x", "y", "width", "height"])
    expect(Math.abs(frameBox[edge] - videoBox[edge])).toBeLessThan(1);
  await expect.poll(() => video.evaluate((node) => node.currentTime)).toBeGreaterThan(0.05);
  await control.click();
  const pausedAt = await video.evaluate((node) => node.currentTime);
  await page.waitForTimeout(160);
  expect(Math.abs((await video.evaluate((node) => node.currentTime)) - pausedAt)).toBeLessThan(0.1);
  await page.screenshot({
    path: fileURLToPath(new URL("./dist/png/delivery__sample-player.png", import.meta.url)),
  });
  await button(page, "定位片头").click();
  await expect.poll(() => video.evaluate((node) => node.currentTime)).toBeLessThan(0.15);
  await control.click();
  await expect.poll(() => video.evaluate((node) => node.currentTime)).toBeGreaterThan(0.05);
  const before = (await calls(page)).length;
  await video.evaluate((node) => node.dispatchEvent(new Event("error")));
  await expect.poll(async () => (await calls(page)).length).toBe(before + 1);
  await expect(video).toBeVisible();
  await video.evaluate((node) => node.dispatchEvent(new Event("error")));
  await expect(page.getByText("样片播放失败，请重新获取播放地址", { exact: true })).toBeVisible();
  expect((await calls(page)).length).toBe(before + 1);
  await page.screenshot({
    path: fileURLToPath(new URL("./dist/png/delivery__sample-retry.png", import.meta.url)),
  });
  await control.click();
  await expect.poll(async () => (await calls(page)).length).toBe(before + 2);
  await expect(video).toBeVisible();
  await control.click();
  await page.locator(".lyx-checkbox").click();
  await page.locator(".lyx-footer-bar .lyx-button").click();
  await expect(video).toHaveCount(0);
  expect((await calls(page)).some((call) => call.path.endsWith("/download-urls"))).toBe(false);
  expect(runtimeErrors).toEqual([]);
  page.off("pageerror", captureError);
}
export async function deliveryNavigationRegression(page, shotPath) {
  await page.evaluate(() => {
    globalThis.__LYX_DELIVERY_SHOT__ = "sample-empty";
  });
  await page.locator(".order-detail .lyx-text-button").filter({ hasText: "查看样片" }).click();
  await expect(page).toHaveURL(
    /sub\/order\/sample\/index\?orderItemId=00000000-0000-4000-8000-000000000411/,
  );
  await expect(page.getByText("暂未推送样片，请等待服务经理", { exact: true })).toBeVisible();
  expect(await calls(page)).toEqual([
    { path: "/m/order-items/00000000-0000-4000-8000-000000000411/sample", method: "GET" },
  ]);
  // Taro 的路由进场动画结束后再取实际目标页画面。
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath });
}
export async function deliveryRegression(page, scene) {
  if (scene === "plan-pending") {
    await button(page, "确认方案").click();
    const confirm = page.locator(".lyx-sheet .lyx-button").filter({ hasText: "确认方案" });
    const path = await page.evaluate(() => globalThis.__LYX_DELIVERY_CALLS__[0].path + "/confirm");
    await page.evaluate((path) => globalThis.__LYX_DELIVERY_CONTROL__.fail(path), path);
    await confirm.click();
    await expect(page.getByText("网络暂时中断，请重试", { exact: true })).toBeVisible();
    await confirm.evaluate((node) => {
      node.click();
      node.click();
    });
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const result = await calls(page),
      writes = result.filter((c) => c.path === path);
    expect(writes).toHaveLength(2);
    expect(writes[0].key).toBe(writes[1].key);
    expect(writes[1].data).toEqual({ versionNo: 2 });
    expect(
      result.filter((c) => c.path === path.replace("/confirm", "") && c.method === "GET").length,
    ).toBeGreaterThan(1);
  }
  if (scene === "plan-change") {
    await button(page, "提交修改说明").click();
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const write = (await calls(page)).find((c) => c.path.endsWith("request-change"));
    expect(write.data).toEqual({ kinds: ["launch_date"], note: "请调整到月底上线" });
    expect(write.key).toBeTruthy();
  }
  if (scene === "sample-viewed") {
    await page.locator(".lyx-footer-bar .lyx-button").click();
    const submit = page.locator(".lyx-sheet .lyx-button");
    const confirmPath = "/m/samples/00000000-0000-4000-8000-000000000020/confirm";
    await page.evaluate((path) => globalThis.__LYX_DELIVERY_CONTROL__.fail(path), confirmPath);
    await submit.click();
    await expect(page.getByText("网络暂时中断，请重试", { exact: true })).toBeVisible();
    await submit.evaluate((node) => {
      node.click();
      node.click();
    });
    await expect(page.locator(".lyx-sheet")).toBeHidden();
    const list = await calls(page),
      writes = list.filter((c) => c.path === confirmPath);
    expect(writes).toHaveLength(2);
    expect(writes[0].data).toEqual({ versionNo: 2, viewedVia: "weapp", hasViewed: true });
    expect(writes[0].key).toBeTruthy();
    expect(writes[1].key).toBe(writes[0].key);
    expect(list.filter((c) => c.path.endsWith("/sample")).length).toBeGreaterThan(1);
    expect(list.some((c) => c.path.endsWith("/download-urls"))).toBe(false);
    await page.evaluate(() => globalThis.__LYX_DELIVERY_CONTROL__.nextSample());
    await button(page, "刷新样片").click();
    await expect(page.getByText("我已查看第 3 版样片", { exact: true })).toBeVisible();
    await expect(page.locator(".lyx-checkbox")).not.toHaveClass(/lyx-checkbox--checked/);
    await expect(page.locator(".lyx-footer-bar .lyx-button")).toHaveClass(/lyx-button--disabled/);
    const path = "/m/order-items/00000000-0000-4000-8000-000000000020/sample";
    const readsBefore = (await calls(page)).filter((c) => c.path === path).length;
    await page.evaluate((path) => globalThis.__LYX_DELIVERY_CONTROL__.hold(path), path);
    await button(page, "刷新样片").click();
    await page.waitForFunction(
      ({ path, count }) =>
        globalThis.__LYX_DELIVERY_CALLS__.filter((c) => c.path === path).length > count,
      { path, count: readsBefore },
    );
    const before = (await calls(page)).length;
    await page.evaluate(() => globalThis.__LYX_DELIVERY_CONTROL__.clerk());
    await expect(page.getByText("仅老板可查看，请切换到老板门店", { exact: true })).toBeVisible();
    await page.evaluate(() => globalThis.__LYX_DELIVERY_CONTROL__.release(true));
    await page.waitForTimeout(100);
    expect((await calls(page)).length).toBe(before);
    expect((await calls(page)).filter((c) => c.path === path)).toHaveLength(readsBefore + 1);
    await expect(page.getByText("迟到保存失败", { exact: true })).toHaveCount(0);
  }
  if (scene.startsWith("sample-")) {
    await expect(button(page, "保存样片到相册查看")).toHaveCount(0);
    await expect(page.locator("video")).toHaveCount(0);
    expect((await calls(page)).some((c) => c.path.endsWith("/download-urls"))).toBe(false);
    if (scene === "sample-legacy" || scene === "sample-disabled") {
      await expect(page.getByText(/请联系服务经理/).first()).toBeVisible();
      await expect(page.locator(".lyx-checkbox")).toHaveClass(/lyx-checkbox--disabled/);
      await expect(page.locator(".lyx-footer-bar .lyx-button")).toHaveClass(/lyx-button--disabled/);
      await expect(button(page, "播放样片")).toHaveCount(0);
    }
  }
  if (scene === "sample-unsaved") await samplePlaybackRegression(page);
  if (scene === "tasks-submit") {
    await button(page, "提交核验").click();
    await expect(page.locator(".lyx-sheet"), "collection submit").toBeHidden();
    const list = await calls(page),
      write = list.find((c) => c.path.endsWith("/submit"));
    expect(write.data).toEqual({
      linkKind: "collection",
      collectionUrl: "https://example.test/collection",
      reportedEpisodeCount: 30,
      actualLaunchDate: "2026-10-07",
    });
    expect(write.key).toBeTruthy();
    expect(list.filter((c) => c.path.startsWith("/m/launch-tasks?")).length).toBeGreaterThan(1);
    expect(list.filter((c) => c.path.endsWith("/summary")).length).toBeGreaterThan(1);
    await button(page, "回填上线链接").first().click();
    await page.locator(".lyx-sheet .lyx-chip").filter({ hasText: "逐集链接" }).click();
    await page
      .locator(".lyx-sheet textarea")
      .fill("1 https://example.test/episode/1\n2 https://example.test/episode/2");
    await page.locator(".lyx-sheet input").nth(0).fill("2");
    await page.locator(".lyx-sheet input").nth(1).fill("2026-10-07");
    await button(page, "提交核验").click();
    await expect(page.locator(".lyx-sheet"), "episode submit").toBeHidden();
    const writes = (await calls(page)).filter((c) => c.path.endsWith("/submit"));
    expect(writes).toHaveLength(2);
    expect(writes[1].key).not.toBe(writes[0].key);
    expect(writes[1].data).toEqual({
      linkKind: "episodes",
      episodeUrls: [
        { episodeNo: 1, url: "https://example.test/episode/1" },
        { episodeNo: 2, url: "https://example.test/episode/2" },
      ],
      reportedEpisodeCount: 2,
      actualLaunchDate: "2026-10-07",
    });
  }
}
