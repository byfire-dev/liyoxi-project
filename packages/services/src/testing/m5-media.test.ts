import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadM5AdMedia, parseM5AdMedia } from "./m5-media.js";

it("真实3秒广告的原生报告与整个字节SHA绑定，不借20秒输入的时长", async () => {
  const { video, report } = await loadM5AdMedia();
  expect(video).toMatchObject({ durationMs: 3000, width: 1080, height: 1920, hasAudio: true });
  expect(report.format.durationMs).toBe(video.durationMs);
  const original = await readFile(new URL("./m1-production.mp4", import.meta.url));
  const proof = await readFile(new URL("./m5-ad.probe.json", import.meta.url));
  expect(() => parseM5AdMedia(original, proof)).toThrow("实际输入字节已改变");
});

it("输入篡改或把报告时长重写都不能成为另一份真实证明", async () => {
  const bytes = await readFile(new URL("./m5-ad.mp4", import.meta.url));
  const proof = await readFile(new URL("./m5-ad.probe.json", import.meta.url));
  const changed = new Uint8Array(bytes);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  expect(() => parseM5AdMedia(changed, proof)).toThrow("实际输入字节已改变");
  const forged = new TextEncoder().encode(
    proof.toString("utf8").replace('"durationMs": 3000', '"durationMs": 20000'),
  );
  expect(() => parseM5AdMedia(bytes, forged)).toThrow("原生体检证明已改变");
});
