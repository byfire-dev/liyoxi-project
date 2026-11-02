import { expect } from "@playwright/test";

export async function trailerRegression(page, scene) {
  const inline = scene === "trailer-inline-landscape";
  const landscape = scene.includes("landscape");
  await expect(page.locator(inline ? "#catalog-ready" : "#trailer-ready")).toBeVisible();
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
  if (!inline)
    expect((await calls()).filter((call) => /^\/m\/dramas\//.test(call.path))).toHaveLength(1);
  // 浏览器现场生成1秒媒体，只替换同源运输，仍通过真实 video 元数据与播放事件。
  const media = await page.evaluate(async (wide) => {
    Object.defineProperty(globalThis.navigator, "connection", {
      configurable: true,
      value: { type: "4g", addEventListener() {}, removeEventListener() {} },
    });
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = wide ? 160 : 90;
    canvas.height = wide ? 90 : 160;
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
        context.fillRect(0, 0, canvas.width, canvas.height);
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
  }, landscape);
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
  await video.evaluate((element) => element.pause());
  expect(await video.evaluate((element) => element.autoplay)).toBe(false);
  expect(await video.evaluate((element) => element.muted)).toBe(true);
  await page
    .locator(".trailer-player .lyx-text-button")
    .filter({ hasText: /^已静音，开启声音$/ })
    .click();
  await expect.poll(() => video.evaluate((element) => element.muted)).toBe(false);
  await expect(page.getByText("全屏观看", { exact: true })).toBeVisible();
  if (landscape) {
    const frame = await page.locator(".trailer-player__frame").boundingBox();
    expect(frame).not.toBeNull();
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);
    expect(await video.evaluate((element) => globalThis.getComputedStyle(element).objectFit)).toBe(
      "contain",
    );
    if (!inline) {
      const facts = await page.locator(".trailer-player__facts").boundingBox();
      const rail = await page.locator(".trailer-page__rail").boundingBox();
      expect(facts.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
      expect(rail.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
    }
    // 真实浏览器拒绝、重试、进入和退出；不以伪造fullscreen事件证明平台能力。
    await video.evaluate((element) => {
      element.__originalRequestFullscreen = element.requestFullscreen;
      element.requestFullscreen = () => Promise.reject(new Error("fixture rejection"));
    });
    await page.locator(".trailer-player__fullscreen").click();
    await expect(page.getByText("暂时无法进入全屏，请重试", { exact: true })).toBeVisible();
    await video.evaluate((element) => {
      element.requestFullscreen = element.__originalRequestFullscreen;
      delete element.__originalRequestFullscreen;
    });
    await page.locator(".trailer-player__fullscreen").click();
    await expect
      .poll(() => video.evaluate((element) => globalThis.document.fullscreenElement === element))
      .toBe(true);
    await expect.poll(() => video.evaluate((element) => element.controls)).toBe(true);
    await video.evaluate((element) => element.play().catch(() => undefined));
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
    await video.evaluate((element) => element.pause());
    await expect(page.getByText("播放预告片", { exact: true })).toHaveCount(1);
    await video.evaluate((element) => element.play().catch(() => undefined));
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
    await page.evaluate(() => globalThis.document.exitFullscreen());
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
    await expect.poll(() => video.evaluate((element) => element.controls)).toBe(false);
    expect((await calls()).filter((call) => call.path.startsWith("/m/playables/"))).toHaveLength(1);
  }
  if (inline) {
    await page
      .locator(".trailer-player")
      .evaluate((node) => node.scrollIntoView({ block: "start" }));
    return;
  }
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
