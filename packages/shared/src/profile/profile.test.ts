import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { profileCompleteness, PROFILE_REQUIRED_ITEMS } from "./index.js";

const keys = Object.values(PROFILE_REQUIRED_ITEMS).flat();
describe("建档完整度", () => {
  it("前三步 11 项；第四步 4 项加许可证；空、满与逐步缺项同源", () => {
    const full = Object.fromEntries(keys.map((key) => [key, true]));
    expect(
      profileCompleteness({ filled: {}, requiredPermits: [], providedPermits: [] }),
    ).toMatchObject({ pct: 0, requiredFilled: 0, requiredTotal: 15 });
    const complete = profileCompleteness({
      filled: full,
      requiredPermits: ["food_business"],
      providedPermits: ["food_business"],
    });
    expect(complete).toMatchObject({ pct: 100, requiredFilled: 16, requiredTotal: 16 });
    expect(complete.steps.map((s) => s.state)).toEqual(Array(4).fill("completed"));
    for (const [step, items] of Object.entries(PROFILE_REQUIRED_ITEMS))
      for (const item of items) {
        const result = profileCompleteness({
          filled: { ...full, [item]: false },
          requiredPermits: [],
          providedPermits: [],
        });
        expect(result.steps[Number(step) - 1]?.missing).toContainEqual({ item, permitType: null });
        expect(result.requiredFilled).toBe(14);
      }
  });
  it("性质：分子不超过分母，补一项不降，重复许可证不重计", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 15, maxLength: 15 }), (flags) => {
        const filled = Object.fromEntries(keys.map((key, i) => [key, flags[i]]));
        const input = {
          filled,
          requiredPermits: ["food_business", "food_business"],
          providedPermits: [],
        };
        const before = profileCompleteness(input);
        expect(before.requiredFilled).toBeLessThanOrEqual(before.requiredTotal);
        expect(before.requiredTotal).toBe(16);
        expect(
          profileCompleteness({ ...input, providedPermits: ["food_business"] }).pct,
        ).toBeGreaterThanOrEqual(before.pct);
        expect(before.steps.flatMap((s) => s.missing).length + before.requiredFilled).toBe(
          before.requiredTotal,
        );
      }),
      { seed: 42, numRuns: Number(process.env.LYX_FC_RUNS ?? 200) },
    );
  });
});
