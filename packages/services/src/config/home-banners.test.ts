import { expect, it } from "vitest";
import { bannerState, checkBannerCapacity } from "./home-banners.js";
const at = new Date("2026-01-01T00:00:00Z");
const row = (start: number, end: number | null, isEnabled = true) => ({
  startAt: new Date(at.getTime() + start),
  endAt: end === null ? null : new Date(at.getTime() + end),
  isEnabled,
});
it("半开区间端点相接不重叠，已结束与停用不占未来容量", () => {
  expect(() =>
    checkBannerCapacity([row(0, 10), row(10, 20), row(-10, 0), row(0, null, false)], at, 1),
  ).not.toThrow();
  expect(() => checkBannerCapacity([row(0, 11), row(10, null)], at, 1)).toThrowError(
    expect.objectContaining({
      error: "BANNER_LIMIT_EXCEEDED",
      details: { activeCount: 2, maxActive: 1, at: new Date(at.getTime() + 10).toISOString() },
    }),
  );
});
it("展示状态disabled优先，边界start含/end不含", () => {
  expect(bannerState(row(-1, 0, false), at)).toBe("disabled");
  expect(bannerState(row(0, 1), at)).toBe("live");
  expect(bannerState(row(1, 2), at)).toBe("scheduled");
  expect(bannerState(row(-1, 0), at)).toBe("ended");
});
