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
describe("W312 exact native trailer templates", () => {
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
