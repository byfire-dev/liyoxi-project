import { expect, it } from "vitest";
import { createM3Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM3Chain } from "./m3-runner.js";

it("M3 两集接口主链、素材采用、清除审批、档案重算与幂等演示", async () => {
  const started = performance.now();
  const support = await createM3Support();
  process.stdout.write(`M3隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    for (const [name, event] of [
      ["content.onMastersChanged", "drama.masters_changed"],
      ["content.onTrailerReady", "drama.trailer_ready"],
    ] as const) {
      const subscriber = support.runtime.assembly.subscriber(name);
      expect(subscriber?.events).toContain(event);
      expect(typeof subscriber?.handle).toBe("function");
    }
    const report = await runM3Chain({
      api: createM1Api(support),
      support,
      say: (message) => process.stdout.write(`M3：${message}\n`),
    });
    expect(report.episodeCount).toBe(2);
    expect(report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(report.invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: 0 });
    expect(report.invariants.checksRun).toBeGreaterThan(0);
    expect(report.replay).toEqual({ inserted: 0, dictionaryPreserved: true });
    process.stdout.write(
      `M3主链完成：2集、素材${report.usages.length}条、不变量${report.invariants.checksRun}项零违规、第二遍零新增\n`,
    );
  } finally {
    await support.close();
  }
  expect(performance.now() - started, "含装配、迁移、主链与自然清理总墙钟").toBeLessThanOrEqual(
    90_000,
  );
}, 90_000);
