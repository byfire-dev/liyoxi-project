import { describe, expect, it } from "vitest";
import type { Technical } from "../production-report.js";
import { ordinaryChecks } from "./ordinary-checks.js";
import { trailerRendition } from "./trailer-rendition.js";

const info = (displayWidth: number | null, displayHeight: number | null): Technical => ({
  kind: "video",
  container: "mp4",
  durationMs: 60_000,
  width: displayWidth,
  height: displayHeight,
  rotation: 0,
  displayWidth,
  displayHeight,
  fpsNum: 30,
  fpsDen: 1,
  vcodec: "h264",
  vprofile: "High",
  pixFmt: "yuv420p",
  bitDepth: 8,
  acodec: "aac",
  audioSampleRate: 48000,
  audioChannels: 2,
  audioStreamCount: 1,
  bitrateKbps: 6000,
  isFaststart: true,
  avDriftMs: 0,
  sizeBytes: 1024,
  aigcMeta: null,
  invalidAigc: false,
  vfr: false,
  raw: {
    demuxer: "mov",
    formatName: "mov,mp4",
    majorBrand: "isom",
    boxes: ["ftyp", "moov", "mdat"],
  },
});

describe("预告片原显示比例与偶数编码边界", () => {
  it.each([
    [1080, 1920, 480, 852, 720, 1280],
    [1920, 1080, 852, 480, 1280, 720],
    [1440, 1080, 640, 480, 960, 720],
    [1080, 1440, 480, 640, 720, 960],
    [1080, 1080, 480, 480, 720, 720],
    [720, 720, 480, 480, 720, 720],
    [721, 1281, 480, 852, 720, 1278],
  ])(
    "%ix%i保持内容比例，不放大并向下取偶数",
    (width, height, sdWidth, sdHeight, hdWidth, hdHeight) => {
      expect(trailerRendition(info(width, height), "sd")).toEqual({
        version: 1,
        width: sdWidth,
        height: sdHeight,
      });
      expect(trailerRendition(info(width, height), "hd")).toEqual({
        version: 1,
        width: hdWidth,
        height: hdHeight,
      });
    },
  );
  it("旋转按已探测的显示尺寸选方向，不按编码宽高二次旋转", () => {
    const rotated = { ...info(1920, 1080), width: 1080, height: 1920, rotation: 90 as const };
    expect(trailerRendition(rotated, "hd")).toEqual({ version: 1, width: 1280, height: 720 });
    expect(ordinaryChecks(rotated, "trailer_src", null).gate).toBe("pass");
  });
  it.each([
    [null, 1280],
    [1280, null],
    [719, 1280],
    [1280, 719],
    [720, 100_000],
  ])("缺尺寸/短边低于720/无法等比适配CI最小边：%s×%s拒绝", (width, height) => {
    expect(trailerRendition(info(width, height), "sd")).toBeNull();
    expect(ordinaryChecks(info(width, height), "trailer_src", null).gate).toBe("reject");
  });
  it("仅预告片接受横屏和其他比例，原片/广告规格及预告音轨时长边界保持", () => {
    for (const dimensions of [
      [1920, 1080],
      [1440, 1080],
      [1080, 1080],
    ] as const) {
      const source = info(dimensions[0], dimensions[1]);
      expect(ordinaryChecks(source, "trailer_src", null).gate).toBe("pass");
      expect(ordinaryChecks(source, "master", null).gate).toBe("reject");
      expect(ordinaryChecks({ ...source, durationMs: 3000 }, "ad", "head").gate).toBe("reject");
    }
    expect(ordinaryChecks(info(720, 1280), "master", null).gate).toBe("pass");
    for (const changes of [{ audioStreamCount: 0 }, { durationMs: 0 }, { durationMs: 180_001 }])
      expect(ordinaryChecks({ ...info(1920, 1080), ...changes }, "trailer_src", null).gate).toBe(
        "reject",
      );
    expect(
      ordinaryChecks({ ...info(1920, 1080), durationMs: 180_000 }, "trailer_src", null).gate,
    ).toBe("pass");
  });
});
