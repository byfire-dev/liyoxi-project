import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

const detailShot = (page, state) =>
  page.screenshot({
    path: fileURLToPath(
      new URL(`./dist/png/catalog__trailer-inline-${state}.png`, import.meta.url),
    ),
  });

async function detailTrailerRegression(page, video, calls) {
  const player = page.locator(".trailer-player");
  const compact = player.locator(".detail-trailer-controls");
  const bar = compact.locator(".detail-trailer-controls__bar");
  // Taro H5 将 ariaRole 映射为 aria-role，不能用 getByRole；限定可点元素并校验 aria-label。
  const button = (name) =>
    compact.locator(
      `:is(.detail-trailer-controls__start, .detail-trailer-controls__toggle, .lyx-icon-button)[aria-label="${name}"]`,
    );
  await expect(bar).toBeVisible();
  await expect(button("播放预告片")).toHaveCount(1);
  await expect(compact.locator(".detail-trailer-controls__start")).toHaveCount(0);
  await button("开启声音").click();
  await expect.poll(() => video.evaluate((element) => element.muted)).toBe(false);
  await expect(button("关闭声音")).toBeVisible();
  await expect(button("全屏观看")).toBeVisible();

  // 暂停超过闲置阈值仍保留操作；随后通过真实播放证明隐藏来自计时，而非自然结束。
  await page.waitForTimeout(3200);
  await expect(bar).toBeVisible();
  expect(await video.evaluate((element) => element.paused)).toBe(true);
  await button("播放预告片").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await expect(button("暂停预告片")).toHaveCount(1);
  await expect(compact.locator(".detail-trailer-controls__start")).toHaveCount(0);
  await detailShot(page, "playing");
  await expect(bar).toHaveCount(0, { timeout: 4500 });
  expect(await video.evaluate((element) => element.paused)).toBe(false);
  await detailShot(page, "hidden");
  await compact.locator('.detail-trailer-controls__surface[aria-label="显示播放控件"]').click();
  await expect(bar).toBeVisible();
  await button("暂停预告片").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);

  // Taro H5 Slider 在原生触摸事件中发出 changing/change；按住超过3秒，松手才提交seek。
  // 回到片头再播放，避免8秒素材在拖动验证期间自然结束。
  await video.evaluate((element) => {
    element.currentTime = 0;
  });
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeLessThan(0.1);
  await button("播放预告片").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  const handle = compact.locator('[aria-label="预告片播放进度"] .weui-slider__handler');
  await expect(handle).toBeVisible();
  await handle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const track = element.closest(".weui-slider__inner").getBoundingClientRect();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    element.__trailerDrag = { ...point, destination: track.x + track.width / 8 };
    const touch = new globalThis.Touch({
      identifier: 1,
      target: element,
      clientX: point.x,
      clientY: point.y,
      pageX: point.x + globalThis.scrollX,
      pageY: point.y + globalThis.scrollY,
    });
    element.dispatchEvent(
      new globalThis.TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }),
    );
    const moved = new globalThis.Touch({
      identifier: 1,
      target: element,
      clientX: element.__trailerDrag.destination,
      clientY: point.y,
      pageX: element.__trailerDrag.destination + globalThis.scrollX,
      pageY: point.y + globalThis.scrollY,
    });
    element.dispatchEvent(
      new globalThis.TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        targetTouches: [moved],
        changedTouches: [moved],
      }),
    );
  });
  await page.waitForTimeout(3200);
  await expect(bar).toBeVisible();
  expect(await video.evaluate((element) => element.paused)).toBe(false);
  await handle.evaluate((element) => {
    const point = element.__trailerDrag;
    const touch = new globalThis.Touch({
      identifier: 1,
      target: element,
      clientX: point.destination,
      clientY: point.y,
      pageX: point.destination + globalThis.scrollX,
      pageY: point.y + globalThis.scrollY,
    });
    element.dispatchEvent(
      new globalThis.TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
      }),
    );
    delete element.__trailerDrag;
  });
  await expect.poll(() => video.evaluate((element) => element.seeking)).toBe(false);
  const afterSeek = await video.evaluate((element) => element.currentTime);
  expect(afterSeek).toBeGreaterThan(0.7);
  expect(afterSeek).toBeLessThan(2.5);
  await button("暂停预告片").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);

  const frame = await player.locator(".trailer-player__frame").boundingBox();
  expect(frame).not.toBeNull();
  expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);
  expect(await video.evaluate((element) => globalThis.getComputedStyle(element).objectFit)).toBe(
    "contain",
  );
  const controls = await bar.boundingBox();
  expect(controls).not.toBeNull();
  expect(controls.x).toBeGreaterThanOrEqual(frame.x - 1);
  expect(controls.y).toBeGreaterThanOrEqual(frame.y - 1);
  expect(controls.x + controls.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  expect(controls.y + controls.height).toBeLessThanOrEqual(frame.y + frame.height + 1);

  // 保留真实浏览器全屏拒绝、进入退出和原生播放守卫；全屏期间不重复渲染自定义控件。
  await video.evaluate((element) => {
    element.__originalRequestFullscreen = element.requestFullscreen;
    element.requestFullscreen = () => Promise.reject(new Error("fixture rejection"));
  });
  await button("全屏观看").click();
  await expect(page.getByText("暂时无法进入全屏，请重试", { exact: true })).toBeVisible();
  await video.evaluate((element) => {
    element.requestFullscreen = element.__originalRequestFullscreen;
    delete element.__originalRequestFullscreen;
  });
  await button("全屏观看").click();
  await expect
    .poll(() => video.evaluate((element) => globalThis.document.fullscreenElement === element))
    .toBe(true);
  await expect.poll(() => video.evaluate((element) => element.controls)).toBe(true);
  await expect(compact).toHaveCount(0);
  await video.evaluate((element) => element.play().catch(() => undefined));
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await video.evaluate((element) => element.pause());
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await expect(compact).toHaveCount(0);
  await video.evaluate((element) => element.play().catch(() => undefined));
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await page.evaluate(() => globalThis.document.exitFullscreen());
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.controls)).toBe(false);
  await expect(bar).toBeVisible();
  await expect(button("播放预告片")).toHaveCount(1);
  // 非全屏时原生play不能绕开自绘播放按钮恢复已暂停的播放器。
  await video.evaluate((element) => element.play().catch(() => undefined));
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  // 自然结束仅保留一个重播入口，重播复用当前有效地址并从片头播放。
  await button("播放预告片").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await expect(button("重播")).toBeVisible({ timeout: 10000 });
  await expect(bar).toHaveCount(0);
  await expect(button("播放预告片")).toHaveCount(0);
  await button("重播").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.05);
  expect(await video.evaluate((element) => element.currentTime)).toBeLessThan(1.5);
  await button("暂停预告片").click();
  expect((await calls()).filter((call) => call.path.startsWith("/m/playables/"))).toHaveLength(1);
  await player.evaluate((node) => node.scrollIntoView({ block: "start" }));
}

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
  if (inline) {
    const player = page.locator(".trailer-player");
    const compact = player.locator(".detail-trailer-controls");
    await player.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await expect(
      compact.locator('.detail-trailer-controls__start[aria-label="播放预告片"]'),
    ).toHaveCount(1);
    await expect(compact.locator(".detail-trailer-controls__start")).toBeVisible();
    await expect(compact).toContainText("00:08");
    await expect(compact.locator(".detail-trailer-controls__bar")).toHaveCount(0);
    await expect(player.locator(":scope > .trailer-player__controls")).toHaveCount(0);
    await expect(player.locator(":scope > .trailer-player__progress")).toHaveCount(0);
    await detailShot(page, "initial");
  }
  // 详情8秒足够验证3秒闲置与拖动；feed保留1秒。只替换运输，仍走真实媒体事件。
  const media = await page.evaluate(
    async ({ wide, durationMs }) => {
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
        }, durationMs);
      });
    },
    { wide: landscape, durationMs: inline ? 8000 : 1000 },
  );
  const mediaBytes = Buffer.from(media, "base64");
  await page.route("**/__lyx_trailer_fixture.mp4", (route) => {
    // Byte ranges let the browser seek real media, rather than silently restart a stream.
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), mediaBytes.length - 1)
      : mediaBytes.length - 1;
    if (start > end || start >= mediaBytes.length)
      return route.fulfill({
        status: 416,
        headers: { "Content-Range": `bytes */${mediaBytes.length}` },
      });
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/webm",
      headers: {
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${mediaBytes.length}` } : {}),
      },
      body: mediaBytes.subarray(start, end + 1),
    });
  });
  await page
    .locator(inline ? ".detail-trailer-controls__start" : ".trailer-player__start .lyx-button")
    .click();
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
  if (inline) {
    await detailTrailerRegression(page, video, calls);
    return;
  }
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
