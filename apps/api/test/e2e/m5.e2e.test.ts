import { expect, it } from "vitest";
import { createM5Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM5Chain } from "./m5-runner.js";

it("M5真实Hono主链：广告订购、样片修改、授权补发、异人取消与全量不变量", async () => {
  const started = performance.now(),
    support = await createM5Support();
  process.stdout.write(`M5隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const report = await runM5Chain({
      api: createM1Api(support),
      support,
      say: (message) => process.stdout.write(`M5：${message}\n`),
    });
    expect(report.episodeCount).toBe(20);
    expect(report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(report.m5).toMatchObject({
      cancelStatus: "done",
      reissueStatus: "published",
      reissueCount: 2,
    });
    expect(report.m5.adVersionNo).toBeGreaterThanOrEqual(2);
    expect(report.m5.sampleVersionNo).toBeGreaterThanOrEqual(3);
    expect(report.m5.cancelRefundPoints).toBeGreaterThan(0);
    expect(report.m5.replayedWriteCount).toBeGreaterThan(0);
    expect(report.m5.docsSubscriber.name).toBe("docs.onRevisionQueued");
    expect(report.m5.docsSubscriber.done).toBeGreaterThan(0);
    expect(report.m5.docsSubscriber.ready).toBeGreaterThan(0);
    expect(report.invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: 0 });
    expect(report.invariants.checksRun).toBeGreaterThan(0);
    expect(report.invariants.checksRun).toBe(
      support.runtime.assembly.invariants.filter((check) => check.modes.includes("full")).length,
    );
  } finally {
    await support.close();
  }
  expect(
    performance.now() - started,
    "装配、迁移、主链、全部full不变量与自然清理总墙钟",
  ).toBeLessThanOrEqual(90_000);
}, 90_000);
