import { describe, expect, it } from "vitest";
import { checkProduction, sampleWatermark } from "./production-checks.js";
import type { ProductionCheckContext, ProductionTechnicalFacts } from "./production-checks.js";

const facts: ProductionTechnicalFacts = {
  container: "mp4",
  videoCodec: "h264",
  videoProfile: "High",
  pixelFormat: "yuv420p",
  bitDepth: 8,
  displayWidth: 1080,
  displayHeight: 1920,
  audioCodec: "aac",
  audioStreamCount: 1,
  sizeBytes: 20 * 1024 * 1024,
  durationMs: 60_000,
  aigcVerified: true,
  faststart: true,
  frameRate: 30,
  variableFrameRate: false,
  avDriftMs: 0,
  bitrateKbps: 4000,
};
const context: ProductionCheckContext = {
  masterId: "master",
  masterDurationMs: 60_000,
  masterDisplayWidth: 1080,
  masterDisplayHeight: 1920,
  headAdMs: 0,
  tailAdMs: 0,
  aiUsed: true,
  masterSource: "declared",
  masterIsCurrent: true,
};
const options = { finalMaxMb: 200, softDurationMs: 180_000 };
const result = (patch: Partial<ProductionTechnicalFacts> = {}, ctx = context) =>
  checkProduction({ ...facts, ...patch }, ctx, options);
const hard = (code: string, patch: Partial<ProductionTechnicalFacts>, ctx = context) =>
  result(patch, ctx).hard.find((h) => h.code === code)?.pass;

describe("production checks D5 H/S", () => {
  it("has exactly seven hard facts and no warnings for a valid measured final", () => {
    expect(result()).toMatchObject({ gate: "pass", soft: [] });
    expect(result().hard.map((h) => h.code)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
  });
  it("rejects absent master context instead of inventing minimum dimensions", () => {
    const r = checkProduction(facts, null, options);
    expect(r.gate).toBe("reject");
    expect(r.hard.find((h) => h.code === "H3")?.pass).toBe(false);
  });
  it("requires MP4 and H264 Main/High eight-bit yuv420p", () => {
    expect(hard("H1", { container: "mov" })).toBe(false);
    for (const p of [
      { videoCodec: "hevc" },
      { videoProfile: "Baseline" },
      { pixelFormat: "yuv420p10le" },
      { bitDepth: null },
    ])
      expect(hard("H2", p)).toBe(false);
    expect(hard("H2", { videoProfile: "Main" })).toBe(true);
  });
  it("uses rotated display dimensions, one percent ratio and the real master width", () => {
    expect(hard("H3", { displayWidth: 720, displayHeight: 1280 })).toBe(false);
    expect(
      hard(
        "H3",
        { displayWidth: 720, displayHeight: 1280 },
        { ...context, masterDisplayWidth: 720 },
      ),
    ).toBe(true);
    expect(hard("H3", { displayWidth: 1080, displayHeight: 1900 })).toBe(false);
    expect(hard("H3", { displayWidth: 1920, displayHeight: 1080 })).toBe(false);
  });
  it("does not pass missing or nonfinite measured dimensions", () => {
    for (const displayWidth of [null, 0, Infinity, NaN])
      expect(hard("H3", { displayWidth })).toBe(false);
  });
  it("requires precisely one AAC stream", () => {
    expect(hard("H4", { audioStreamCount: 0 })).toBe(false);
    expect(hard("H4", { audioStreamCount: 2 })).toBe(false);
    expect(hard("H4", { audioCodec: "mp3" })).toBe(false);
  });
  it("honors configured size with the immutable 200 MiB ceiling", () => {
    expect(hard("H5", { sizeBytes: 200 * 1024 * 1024 })).toBe(true);
    expect(hard("H5", { sizeBytes: 200 * 1024 * 1024 + 1 })).toBe(false);
    expect(
      checkProduction({ ...facts, sizeBytes: 51 * 1024 * 1024 }, context, {
        ...options,
        finalMaxMb: 50,
      }).gate,
    ).toBe("reject");
    expect(() => checkProduction(facts, context, { ...options, finalMaxMb: 201 })).toThrow();
  });
  it("uses [20 seconds,20 minutes) and rejects absent duration", () => {
    expect(hard("H6", { durationMs: 20_000 })).toBe(true);
    for (const durationMs of [19_999, 1_200_000, null, Infinity])
      expect(hard("H6", { durationMs })).toBe(false);
  });
  it("requires real AIGC readback only when the original declaration used AI", () => {
    expect(hard("H7", { aigcVerified: false })).toBe(false);
    expect(hard("H7", { aigcVerified: false }, { ...context, aiUsed: false })).toBe(true);
  });
  it("computes all ten independent soft warnings from facts and current context", () => {
    const r = result(
      {
        sizeBytes: 101 * 1024 * 1024,
        durationMs: 181_000,
        faststart: false,
        frameRate: 24,
        avDriftMs: 81,
        bitrateKbps: 8001,
        displayWidth: 720,
        displayHeight: 1280,
      },
      { ...context, masterSource: "current_fallback", masterIsCurrent: false },
    );
    expect(r.soft.map((s) => s.code)).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
      "S9",
      "S10",
    ]);
    expect(r.soft.every((s) => s.level === "warn")).toBe(true);
  });
  it("does not warn at inclusive soft boundaries and accounts for both ads", () => {
    expect(
      result({ sizeBytes: 100 * 1024 * 1024, durationMs: 61_500, avDriftMs: 80, bitrateKbps: 8000 })
        .soft,
    ).toEqual([]);
    expect(
      result({ durationMs: 65_000 }, { ...context, headAdMs: 2000, tailAdMs: 3000 }).soft,
    ).toEqual([]);
    expect(
      checkProduction(
        { ...facts, durationMs: 181_000 },
        { ...context, masterDurationMs: 181_000 },
        { ...options, softDurationMs: null },
      ).soft,
    ).toEqual([]);
  });
  it("warns for variable rate even if nominal rate is 30", () => {
    expect(result({ variableFrameRate: true }).soft.map((s) => s.code)).toEqual(["S5"]);
  });
});

describe("sample watermark", () => {
  it("cleans special/control characters, trims to ten code points and uses Beijing date", () => {
    expect(
      sampleWatermark(' <狸>\n\u0000有"戏\\商家1234567890', new Date("2026-10-08T16:05:00Z")),
    ).toBe("样片 · 仅供「狸有戏商家12345」确认 · 10-09");
  });
  it("keeps Unicode characters without cutting a surrogate pair", () => {
    expect(sampleWatermark("😀".repeat(12), new Date("2026-01-01T00:00:00Z"))).toBe(
      `样片 · 仅供「${"😀".repeat(10)}」确认 · 01-01`,
    );
  });
  it("rejects an empty sanitized name and invalid clock", () => {
    expect(() => sampleWatermark("<>\u0000", new Date())).toThrow();
    expect(() => sampleWatermark("狸有戏", new Date(NaN))).toThrow();
  });
});
