import { expect, it } from "vitest";
import { createM4Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM4Chain } from "./m4-runner.js";

it("M4真实Hono资金链：支付退款、两人线下入账、发票、差异配置与全量不变量", async () => {
  const started = performance.now(),
    support = await createM4Support();
  process.stdout.write(`M4隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const report = await runM4Chain({
      api: createM1Api(support),
      support,
      say: (message) => process.stdout.write(`M4：${message}\n`),
    });
    expect(report.paidFen).toBeGreaterThan(0);
    expect(report.refundedFen).toBe(report.paidFen);
    expect(report.finance.modes).toEqual(["hidden", "offline_contract", "in_app", "in_app"]);
    expect(report.reconciliation).toMatchObject({
      status: "diff",
      parsed: 1,
      waiting: 89,
      failed: 0,
    });
    expect(report.invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: 0 });
    expect(report.invariants.checksRun).toBeGreaterThan(0);
  } finally {
    await support.close();
  }
  expect(
    performance.now() - started,
    "装配、迁移、主链、不变量与自然清理总墙钟",
  ).toBeLessThanOrEqual(90_000);
}, 90_000);
