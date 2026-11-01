import { expect } from "@playwright/test";

export async function trailerRegression(page, scene) {
  await expect(page.locator("#trailer-ready")).toBeVisible();
  const calls = () => page.evaluate(() => globalThis.__LYX_TRAILER_CALLS__ ?? []);
  expect((await calls()).some((call) => call.path.startsWith("/m/playables/"))).toBe(false);
  if (scene === "trailer-disabled") {
    await expect(page.getByText("预告片模式暂未开放", { exact: true })).toBeVisible();
    expect(
      (await calls()).filter((call) => /^\/m\/(?:dramas|playables)(?:\/|\?|$)/.test(call.path)),
    ).toEqual([]);
    await expect(page.locator(".trailer-player__video")).toHaveCount(0);
    return;
  }
  if (scene === "trailer-empty") {
    await expect(page.getByText("暂无短剧", { exact: true })).toBeVisible();
    expect((await calls()).some((call) => /^\/m\/dramas\//.test(call.path))).toBe(false);
    return;
  }
  if (scene === "trailer-error") {
    await expect(page.getByText("预告片列表加载失败，请重试", { exact: true })).toBeVisible();
    await expect(page.locator(".trailer-player__video")).toHaveCount(0);
    return;
  }
  expect((await calls()).filter((call) => /^\/m\/dramas\//.test(call.path))).toHaveLength(1);
  // 浏览器现场生成1秒媒体，只替换同源运输，仍通过真实 video 元数据与播放事件。
  const media = await page.evaluate(async () => {
    Object.defineProperty(globalThis.navigator, "connection", {
      configurable: true,
      value: { type: "4g", addEventListener() {}, removeEventListener() {} },
    });
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = 90;
    canvas.height = 160;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(12),
      chunks = [];
    const recorder = new globalThis.MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    return new Promise((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const reader = new globalThis.FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(new globalThis.Blob(chunks, { type: "video/webm" }));
      };
      let frame = 0;
      const draw = () => {
        context.fillStyle = "#1D1A16";
        context.fillRect(0, 0, 90, 160);
        context.fillStyle = "#C4501B";
        context.fillRect(10, 20 + (frame++ % 60), 70, 40);
      };
      draw();
      recorder.start();
      const timer = setInterval(draw, 80);
      setTimeout(() => {
        clearInterval(timer);
        recorder.stop();
      }, 1000);
    });
  });
  await page.route("**/__lyx_trailer_fixture.mp4", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/webm",
      body: Buffer.from(media, "base64"),
    }),
  );
  await page.locator(".trailer-player__start .lyx-button").click();
  const mobile = page.locator(".lyx-sheet .lyx-button").filter({ hasText: /^继续播放预告片$/ });
  await expect(mobile).toBeVisible();
  await mobile.click();
  await expect(page.locator(".trailer-player__video")).toBeVisible();
  await expect
    .poll(
      async () => (await calls()).filter((call) => call.path.startsWith("/m/playables/")).length,
    )
    .toBe(1);
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.05);
  expect(await video.evaluate((element) => element.autoplay)).toBe(false);
  expect(await video.evaluate((element) => element.muted)).toBe(true);
  await page
    .locator(".trailer-player__mute .lyx-text-button")
    .filter({ hasText: /^已静音，开启声音$/ })
    .click();
  await expect.poll(() => video.evaluate((element) => element.muted)).toBe(false);
  const railAdd = page.locator(".trailer-page__rail-action").filter({ hasText: /^加选剧单$/ });
  await railAdd.click();
  await expect(
    page.locator(".trailer-page__rail-action").filter({ hasText: /^已在选剧单$/ }),
  ).toBeVisible();
  await expect(
    page.locator(".trailer-page__buttons .lyx-button").filter({ hasText: /^已在选剧单$/ }),
  ).toBeVisible();
  expect(
    (await calls()).filter((call) => call.path === "/m/cart-items" && call.method === "POST"),
  ).toHaveLength(1);
}
