import { expect, it } from "vitest";
import { createM2Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM2Chain } from "./m2-runner.js";

it("M2 完整生命周期、M1 上线主链、真实运输恢复与全量不变量", async () => {
  const at = performance.now(),
    support = await createM2Support();
  process.stdout.write(`M2隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const report = await runM2Chain({
      api: createM1Api(support),
      support,
      say: (message) => process.stdout.write(`${message}\n`),
    });
    expect(report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(report.invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: 0 });
    expect(report.invariants.checksRun).toBeGreaterThan(0);
    expect(report.replay).toEqual({ invitations: true, seedsInserted: 0 });
    expect(report.ops).toMatchObject({ timerRescheduled: true, deliveryRetried: true });
    process.stdout.write(`M2主链完成：${JSON.stringify(report)}\n`);
  } finally {
    await support.close();
  }
  expect(performance.now() - at, "含装配、迁移、主链、不变量与清理").toBeLessThanOrEqual(90_000);
}, 90_000);
