import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { usageExtensionTarget } from "./usage-lifecycle.js";

const input = {
  source: "license",
  phase: "to_launch",
  step: "awaiting_launch",
  oldEnd: "2024-02-28",
  currentEnd: "2024-02-29",
  currentRevision: "current",
  revision: "current",
  cancelled: false,
};
describe("W6-01 使用期单调顺延性质", () => {
  it("任意顺延/缩短/旧版通知序列只能取当前有效止日的最大值", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ days: fc.integer({ min: -800, max: 800 }), stale: fc.boolean() }), {
          minLength: 1,
          maxLength: 100,
        }),
        (steps) => {
          let actual = input.oldEnd,
            expected = input.oldEnd;
          for (const step of steps) {
            const end = addDays(input.oldEnd, step.days);
            if (!step.stale && end > expected) expected = end;
            actual =
              usageExtensionTarget({
                ...input,
                oldEnd: actual,
                currentEnd: end,
                revision: step.stale ? "old" : "current",
              }) ?? actual;
            expect(actual).toBe(expected);
          }
        },
      ),
      { numRuns: 300, seed: 601 },
    );
  });
  it.each(["2024-02-29", "2026-01-31", "2026-12-31"])("%s止日次日上海零点前后一毫秒边界", (end) => {
    const expires = dayRange(addDays(end, 1)).start;
    expect(expires.toISOString().slice(11)).toBe("16:00:00.000Z");
    expect(calendarDate(new Date(expires.getTime() - 1))).toBe(end);
    expect(calendarDate(expires)).toBe(addDays(end, 1));
  });
  it.each(["takedown", "archived", "terminated"])("%s工单不会因续期复活", (step) => {
    expect(usageExtensionTarget({ ...input, step })).toBeNull();
  });
  it.each(["cancelled", "refunded", "ended", "terminated"])("%s订单项不会因续期复活", (phase) => {
    expect(usageExtensionTarget({ ...input, phase })).toBeNull();
  });
  it("固定使用期、在途取消、缺版次和相同日期均不顺延", () => {
    for (const patch of [
      { source: "fixed" },
      { cancelled: true },
      { currentRevision: null },
      { currentEnd: null },
      { currentEnd: input.oldEnd },
    ])
      expect(usageExtensionTarget({ ...input, ...patch })).toBeNull();
  });
});
