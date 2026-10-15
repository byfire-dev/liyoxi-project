import { describe, expect, it } from "vitest";
import {
  coverage,
  P95_OPERATION_IDS,
  measure,
  percentile,
  reportPassed,
  settings,
} from "../p95.mjs";
describe("P95真实样本边界", () => {
  it("本机档有界且保留12路覆盖，缺写样本或重复/额外路由不能假完整", () => {
    expect(settings(["--profile", "local"])).toMatchObject({
      profile: "local",
      concurrency: 1,
      scale: 0.04,
      seed: 42,
      samples: 20,
    });
    expect(settings([]).profile).toBe("formal");
    for (const args of [
      ["--profile", "unknown"],
      ["--profile", "local", "--scale", "10"],
      ["--profile", "local", "--concurrency", "20"],
      ["--profile", "local", "--scale", "0.002"],
    ])
      expect(() => settings(args)).toThrow();
    expect(P95_OPERATION_IDS).toHaveLength(12);
    expect(P95_OPERATION_IDS).toContain("m.order.create");
    expect(P95_OPERATION_IDS).toContain("m.paymentOrder.create");
    expect(coverage(P95_OPERATION_IDS)).toMatchObject({
      complete: true,
      missing: [],
      duplicates: [],
      unexpected: [],
    });
    expect(coverage(P95_OPERATION_IDS.filter((id) => !id.endsWith(".create")))).toMatchObject({
      complete: false,
      missing: ["m.order.create", "m.paymentOrder.create"],
    });
    expect(coverage([...P95_OPERATION_IDS, P95_OPERATION_IDS[0]!]).complete).toBe(false);
    expect(coverage([...P95_OPERATION_IDS, "unregistered"]).complete).toBe(false);
  });
  it("默认20/10/42与500ms，拒任意目标、可放松阈值/无效规模", () => {
    expect(settings([])).toMatchObject({ concurrency: 20, scale: 10, seed: 42, samples: 100 });
    for (const args of [
      ["--url", "https://example.com"],
      ["--threshold", "99999"],
      ["--concurrency", "21"],
      ["--scale", "0"],
      ["--seed", "NaN"],
    ])
      expect(() => settings(args)).toThrow();
    expect(() => percentile([])).toThrow();
    expect(percentile(Array.from({ length: 100 }, (_, n) => n + 1))).toBe(95);
  });
  it("有界并发/全部实际请求，错误率与500ms超限都失败，无空样本绿色", async () => {
    let active = 0,
      max = 0,
      calls = 0;
    const result = await measure(
      async (n: number) => {
        active++;
        max = Math.max(max, active);
        calls++;
        await new Promise((r) => setTimeout(r, 1));
        active--;
        if (n === 7) throw new Error("UNAVAILABLE");
      },
      { concurrency: 3, samples: 20 },
    );
    expect(max).toBe(3);
    expect(Object.values(result.distribution).reduce((n, v) => n + v, 0)).toBe(20);
    expect(result.p50Ms).toBeLessThanOrEqual(result.p90Ms);
    expect(result.p90Ms).toBeLessThanOrEqual(result.p95Ms);
    expect(calls).toBe(20);
    expect(result).toMatchObject({
      samples: 20,
      failures: 1,
      errorRate: 0.05,
      passed: false,
      errors: { UNAVAILABLE: 1 },
    });
    expect(reportPassed({ routes: [] })).toBe(false);
    expect(reportPassed({ routes: [{ samples: 20, failures: 0, p95Ms: 500.01 }] })).toBe(false);
    expect(reportPassed({ routes: [{ samples: 20, failures: 0, p95Ms: 500 }] })).toBe(true);
    const slow = await measure(() => new Promise((r) => setTimeout(r, 510)), {
      concurrency: 20,
      samples: 20,
    });
    expect(slow.passed).toBe(false);
  });
});
