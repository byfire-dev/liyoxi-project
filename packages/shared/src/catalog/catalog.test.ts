import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { stopDate, visible, orderable, selectPermits } from "./index.js";
describe("商城自然月止订日", () => {
  it("当天不可见，月末与闰年夹到当月最后一天", () => {
    expect(stopDate("2026-12-25", 3)).toBe("2026-09-25");
    const f = { status: "listed", licenseEndDate: "2026-12-25", minLicenseMonths: 3 };
    expect(visible(f, "2026-09-24")).toBe(true);
    expect(visible(f, "2026-09-25")).toBe(false);
    expect(stopDate("2026-05-31", 3)).toBe("2026-02-28");
    expect(stopDate("2024-05-31", 3)).toBe("2024-02-29");
  });
  it("所有月份末日的回推结果都是真实日期，且零月回推恒等", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 36 }),
        (year, month, n) => {
          const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
          const date = `${year}-${String(month).padStart(2, "0")}-${last}`;
          expect(stopDate(date, 0)).toBe(date);
          expect(new Date(`${stopDate(date, n)}T00:00:00Z`).toISOString().slice(0, 10)).toBe(
            stopDate(date, n),
          );
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });
  it("草稿归档、平台权利与许可强度，具体平台覆盖 all 同种编号", () => {
    const permits = [
      { platform: "all", kind: "program_no", number: "a" },
      { platform: "douyin", kind: "program_no", number: "b" },
    ];
    expect(selectPermits(permits, "douyin").map((row) => row.number)).toEqual(["b"]);
    const f = {
      status: "listed",
      licenseEndDate: "2027-12-25",
      minLicenseMonths: 3,
      platforms: ["douyin"],
      permits,
      dramaClass: "class_3",
      permitCheck: "block" as const,
    };
    expect(orderable(f, ["douyin"], "2026-09-24")).toBe(true);
    expect(orderable(f, ["wechat_channels"], "2026-09-24")).toBe(false);
    expect(orderable({ ...f, permits: [] }, ["douyin"], "2026-09-24")).toBe(false);
    expect(orderable({ ...f, permits: [], permitCheck: "warn" }, ["douyin"], "2026-09-24")).toBe(
      true,
    );
    expect(visible({ ...f, archivedAt: new Date() }, "2026-09-24")).toBe(false);
    expect(visible({ ...f, status: "draft" }, "2026-09-24")).toBe(false);
  });
});
