import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decideMediaConvergence, systemProduceId } from "./convergence.js";
import { jobBudget, nextPollDelay, retryDelay } from "./policy.js";
const state = fc.constantFrom(
  "queued",
  "running",
  "submitting",
  "submitted",
  "succeeded",
  "failed",
  "canceled",
);
describe("媒体纯汇合/固定预算性质", () => {
  it("任务乱序不改变决策，任何未终态均等待，不把空集合当成功", () => {
    fc.assert(
      fc.property(fc.array(state, { maxLength: 20 }), (states) => {
        expect(decideMediaConvergence(states)).toBe(decideMediaConvergence([...states].reverse()));
        if (
          states.length === 0 ||
          states.some((one) => ["queued", "running", "submitting", "submitted"].includes(one))
        )
          expect(decideMediaConvergence(states)).toBe("pending");
        if (decideMediaConvergence(states) === "succeeded")
          expect(states.length > 0 && states.every((one) => one === "succeeded")).toBe(true);
      }),
      { numRuns: 100, seed: 303 },
    );
  });
  it("轮询始终5秒至60秒，退避正式1/5/15分钟，prototype不是kind", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1_000_000 }), (previous) => {
        const next = nextPollDelay(previous);
        expect(next).toBeGreaterThanOrEqual(5000);
        expect(next).toBeLessThanOrEqual(60_000);
      }),
      { numRuns: 100, seed: 3303 },
    );
    expect([retryDelay(1), retryDelay(2), retryDelay(3)]).toEqual([60_000, 300_000, 900_000]);
    for (const key of ["constructor", "__proto__", "toString"]) expect(jobBudget(key)).toBeNull();
    expect(jobBudget("promote")).toEqual({
      hardTimeoutMs: 240_000,
      leaseMs: 300_000,
      deadlineMs: 1_800_000,
    });
  });
  it("ProduceID仅新系统补标使用规范小写UUIDv7，不能重写上游标识", () => {
    const id = "019acdef-0000-7000-8000-000000000000";
    expect(systemProduceId(id)).toBe(`lyx:${id}`);
    for (const bad of [id.toUpperCase(), id.replace("-7000", "-4000"), "constructor", "lyx:" + id])
      expect(() => systemProduceId(bad)).toThrow(TypeError);
  });
});
