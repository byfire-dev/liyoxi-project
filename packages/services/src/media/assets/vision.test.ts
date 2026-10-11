import { describe, expect, it } from "vitest";
import { visionContent, visionFrameTimes, visionProjection } from "./vision.js";

const visible = {
  description: "公开虚构厨房",
  quality: "画面清晰",
  hasPeople: true,
  identifiableCustomerFace: false,
  textInImage: "今日菜单",
};
const completion = {
  ...visible,
  sourceHash: "a".repeat(64),
  frameAtMs: [500, 1500, 2500, 3500, 4500, 5500],
  cacheSourceId: null,
};

describe("vision bounded requested frame times, not observed cloud PTS", () => {
  it.each([
    [6, 6],
    [59_999, 6],
    [60_000, 6],
    [60_001, 8],
    [120_000, 8],
    [120_001, 10],
    [240_000, 12],
    [240_001, 14],
    [300_000, 14],
    [2_147_483_647, 14],
  ])("%i milliseconds requests exactly %i ordered interval centers", (duration, count) => {
    const times = visionFrameTimes(duration);
    expect(times).toEqual(
      Array.from({ length: count }, (_, index) =>
        Math.floor(((2 * index + 1) * duration) / (2 * count)),
      ),
    );
    expect(times).toHaveLength(count);
    expect(new Set(times).size).toBe(count);
    expect(
      times!.every(
        (time, index) => time >= 0 && time < duration && (index === 0 || time > times![index - 1]!),
      ),
    ).toBe(true);
  });

  it.each([null, 0, 5, -1, 6.5, NaN, Infinity, 2_147_483_648, "60000"])(
    "invalid duration %s is never replaced with a fabricated default",
    (duration) => expect(visionFrameTimes(duration)).toBeUndefined(),
  );
});

describe("strict five public fields separated from job-only provenance", () => {
  it("projects exactly the five fields without private source, cache, or requested times", () => {
    expect(visionContent(completion)).toEqual(visible);
    expect(Object.keys(visionContent(completion)!).sort()).toEqual(Object.keys(visible).sort());
    expect(completion.sourceHash).toBe("a".repeat(64));
    expect(completion.frameAtMs).toHaveLength(6);
  });
  it("explicit empty strings and false booleans are valid facts", () => {
    const empty = {
      description: "",
      quality: "",
      hasPeople: false,
      identifiableCustomerFace: false,
      textInImage: "",
    };
    expect(visionContent({ ...completion, ...empty })).toEqual(empty);
  });
  it("missing required public or private fields cannot become successful business content", () => {
    for (const key of Object.keys(completion)) {
      const missing = { ...completion } as Record<string, unknown>;
      delete missing[key];
      expect(visionContent(missing)).toBeUndefined();
    }
  });
  it("unknown public fields and persisted signed URLs are rejected rather than stripped", () => {
    for (const extra of [{ tags: [] }, { url: "https://public.invalid/signed" }, { frameCount: 6 }])
      expect(visionContent({ ...completion, ...extra })).toBeUndefined();
  });
});

describe("digest visible-fact projection", () => {
  it("legacy description is left to the existing legacy digest branch", () => {
    expect(visionProjection({ description: "合法旧洞察", tags: [] })).toBeUndefined();
  });
  it("all five named facts are visible without turning a face hint into authorization", () => {
    expect(visionProjection(visible)).toBe(
      "description: 公开虚构厨房\nquality: 画面清晰\ntextInImage: 今日菜单\nhasPeople: true\nidentifiableCustomerFace: false",
    );
  });
  it("boolean-only facts do not fabricate text for a complete digest", () => {
    expect(
      visionProjection({
        ...visible,
        description: " ",
        quality: "",
        textInImage: "",
        hasPeople: true,
        identifiableCustomerFace: true,
      }),
    ).toBeUndefined();
  });
  it("Unicode boundaries preserve the full projection for the aggregate bound and source hash", () => {
    const content = {
      ...visible,
      description: "🍜".repeat(2000),
      quality: "😀".repeat(500),
      textInImage: "菜".repeat(8000),
    };
    const projected = visionProjection(content)!;
    expect(projected).toContain(content.description);
    expect(projected).toContain(content.quality);
    expect(projected).toContain(content.textInImage);
    expect(Array.from(projected).length).toBeGreaterThan(10_500);
    expect(
      visionProjection({ ...content, description: `${content.description}🍜` }),
    ).toBeUndefined();
  });
});
