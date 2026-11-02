import { describe, expect, it } from "vitest";
import {
  matchesTrailerInput,
  parseTrailerSubmission,
  trailerEncoding,
} from "./upload-batch-live-trailer.js";

const job = "019a1234-5678-7123-8123-123456789001";
const file = "019a1234-5678-7123-8123-123456789002";
const asset = "019a1234-5678-7123-8123-123456789003";
const drama = "019a1234-5678-7123-8123-123456789004";
const source = "019a1234-5678-7123-8123-123456789005";
function fixture(quality: "sd" | "hd" = "sd", ai = false) {
  const watermarks = [{ templateId: "test_brand" }, ...(ai ? [{ templateId: "test_ai" }] : [])];
  return {
    request: {
      src: { bucket: "media" as const, key: `trailer_src/platform/${source}.mp4` },
      dst: { bucket: "media" as const, key: `ci-out/${job}/output.mp4` },
      template: `test_${quality}`,
      userData: `${job}:1`,
      watermarks,
      signal: new AbortController().signal,
    },
    persisted: {
      fileId: file,
      playableAssetId: asset,
      destinationFileId: source,
      quality,
      objectKey: `t/${drama}/0123456789abcdef/${quality}.mp4`,
      scratchKey: `ci-out/${job}/output.mp4`,
      template: `test_${quality}`,
      specVersion: 1,
      aiUsed: ai,
      watermarks,
    },
  };
}
function renditionFixture(quality: "sd" | "hd", width: number, height: number, ai = false) {
  const legacy = fixture(quality, ai);
  return {
    request: {
      src: legacy.request.src,
      dst: legacy.request.dst,
      userData: legacy.request.userData,
      watermarks: legacy.request.watermarks,
      signal: legacy.request.signal,
      rendition: { quality, width, height },
    },
    persisted: {
      fileId: file,
      playableAssetId: asset,
      destinationFileId: source,
      quality,
      objectKey: legacy.persisted.objectKey,
      scratchKey: legacy.persisted.scratchKey,
      rendition: { version: 1, width, height },
      specVersion: 1,
      aiUsed: ai,
      watermarks: legacy.persisted.watermarks,
    },
  };
}
describe("W312 exact native trailer templates", () => {
  it.each([
    ["sd", 852, 480],
    ["hd", 1280, 720],
    ["hd", 720, 720],
    ["hd", 1280, 256],
  ] as const)(
    "%s exact %ix%i inline recipe reaches the native fit/pad filter",
    (quality, width, height) => {
      const { request, persisted } = renditionFixture(quality, width, height, true);
      expect(parseTrailerSubmission(request)).toEqual({ id: job, attemptNo: 1 });
      expect(matchesTrailerInput(request, persisted)?.rendition).toEqual({
        version: 1,
        width,
        height,
      });
      const encoding = trailerEncoding(quality, true, { width, height });
      expect(encoding.filter).toContain(
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,`,
      );
      expect(encoding.filter).toContain(
        `text='AI 生成':expansion=none:fontsize=${Math.ceil(Math.min(width, height) * 0.06)}:`,
      );
      expect(encoding.profile).toBe(quality === "sd" ? "main" : "high");
      expect(encoding.videoBitrate).toBe(quality === "sd" ? "700k" : "1500k");
      expect(encoding.audioBitrate).toBe(quality === "sd" ? "64k" : "96k");
      expect(encoding.filter).not.toContain("crop=");
    },
  );
  it("inline recipe must match version/dimensions/quality exactly and cannot mix a template", () => {
    const { request, persisted } = renditionFixture("hd", 1280, 720);
    expect(matchesTrailerInput(request, { ...persisted, template: "test_hd" })).toBeNull();
    expect(
      matchesTrailerInput(
        { ...request, template: "test_hd" } as unknown as Parameters<typeof matchesTrailerInput>[0],
        persisted,
      ),
    ).toBeNull();
    expect(
      matchesTrailerInput(request, {
        ...persisted,
        rendition: { ...persisted.rendition, version: 2 },
      }),
    ).toBeNull();
    expect(
      matchesTrailerInput(request, {
        ...persisted,
        rendition: { ...persisted.rendition, width: 720, height: 1280 },
      }),
    ).toBeNull();
    expect(
      matchesTrailerInput(request, {
        ...persisted,
        rendition: { ...persisted.rendition, height: 719 },
      }),
    ).toBeNull();
    expect(
      matchesTrailerInput(request, {
        ...persisted,
        rendition: { ...persisted.rendition, crop: true },
      }),
    ).toBeNull();
    expect(
      matchesTrailerInput(
        { ...request, rendition: { ...request.rendition, quality: "sd" } },
        persisted,
      ),
    ).toBeNull();
    expect(
      matchesTrailerInput(
        { ...request, rendition: { ...request.rendition, width: 720, height: 1280 } },
        persisted,
      ),
    ).toBeNull();
    expect(matchesTrailerInput(request, { ...persisted, watermarks: [] })).toBeNull();
    expect(matchesTrailerInput(request, { ...persisted, aiUsed: true })).toBeNull();
    expect(matchesTrailerInput(request, fixture("hd").persisted)).toBeNull();
    expect(matchesTrailerInput(fixture("hd").request, persisted)).toBeNull();
    expect(() => trailerEncoding("hd", false, { width: 1280, height: 719 })).toThrow();
  });
  it.each(["sd", "hd"] as const)(
    "%s maps real dimensions/codecs/bitrates and an actual brand filter",
    (quality) => {
      const mapping = trailerEncoding(quality, false);
      expect(mapping).toEqual({
        filter: `[0:v]scale=${quality === "sd" ? "480:854" : "720:1280"},setsar=1,drawtext=fontfile=/app/fonts/NotoSansCJKsc-Regular.otf:text='狸有戏':expansion=none:fontsize=${quality === "sd" ? 24 : 36}:fontcolor=white@0.7:x=w-text_w-16:y=16[out]`,
        profile: quality === "sd" ? "main" : "high",
        videoBitrate: quality === "sd" ? "700k" : "1500k",
        audioBitrate: quality === "sd" ? "64k" : "96k",
      });
      const value = fixture(quality);
      expect(matchesTrailerInput(value.request, value.persisted)?.quality).toBe(quality);
    },
  );
  it.each(["sd", "hd"] as const)(
    "%s AI maps a full-duration visible stamp with short-edge 5% font",
    (quality) => {
      const value = fixture(quality, true);
      expect(matchesTrailerInput(value.request, value.persisted)?.aiUsed).toBe(true);
      expect(trailerEncoding(quality, true).filter).toContain(
        `text='AI 生成':expansion=none:fontsize=${quality === "sd" ? 29 : 44}:fontcolor=white:x=16:y=h-text_h-16[out]`,
      );
      expect(trailerEncoding(quality, false).filter).not.toContain("AI 生成");
    },
  );
  it("requires the real job/attempt and exact source/destination references", () => {
    const { request } = fixture();
    expect(parseTrailerSubmission(request)).toEqual({ id: job, attemptNo: 1 });
    expect(
      parseTrailerSubmission({
        ...request,
        src: { bucket: "media", key: `trailer_src/other/${source}.mp4` },
      }),
    ).toBeNull();
    expect(
      parseTrailerSubmission({
        ...request,
        dst: { bucket: "media", key: `ci-out/${file}/output.mp4` },
      }),
    ).toBeNull();
    expect(
      parseTrailerSubmission({ ...request, src: { ...request.src, bucket: "pub" } }),
    ).toBeNull();
    expect(parseTrailerSubmission({ ...request, signal: undefined })).toBeNull();
  });
  it.each([`${job}:0`, `${job}:1:other`, "not-a-uuid:1", `${job}:-1`, `${job}:1000000`])(
    "rejects an unowned or malformed attempt %s",
    (userData) => {
      expect(parseTrailerSubmission({ ...fixture().request, userData })).toBeNull();
    },
  );
  it("rejects mismatched quality/template and the old sample image watermark shape", () => {
    const { request, persisted } = fixture();
    expect(matchesTrailerInput({ ...request, template: "test_hd" }, persisted)).toBeNull();
    expect(matchesTrailerInput(request, { ...persisted, template: "test_sample" })).toBeNull();
    expect(matchesTrailerInput(request, { ...persisted, quality: "source" })).toBeNull();
    expect(
      matchesTrailerInput(
        { ...request, watermarks: [{ image: request.src, position: "Center", transparency: 30 }] },
        persisted,
      ),
    ).toBeNull();
  });
  it("requires exactly the brand and optional declared AI templates, with no extra input", () => {
    const { request, persisted } = fixture();
    expect(matchesTrailerInput({ ...request, watermarks: [] }, persisted)).toBeNull();
    expect(matchesTrailerInput(request, { ...persisted, aiUsed: true })).toBeNull();
    expect(matchesTrailerInput(request, { ...persisted, arbitrary: true })).toBeNull();
    expect(
      matchesTrailerInput(request, { ...persisted, watermarks: [{ templateId: "ignored_brand" }] }),
    ).toBeNull();
    const ai = fixture("hd", true);
    expect(
      matchesTrailerInput(
        { ...ai.request, watermarks: [...ai.request.watermarks].reverse() },
        ai.persisted,
      ),
    ).toBeNull();
  });
});
