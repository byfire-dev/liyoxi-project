import { expect, it } from "vitest";
import { createM1Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM1Chain } from "./runner.js";

it("M1 七段真实接口主路径：登录建档、对公入账、订剧交付到已上线及全量不变量", async () => {
  const started = performance.now();
  const support = await createM1Support();
  // 仅打印本轮隔离资源标识；异常超时时可据此精确收尾，避免猜测其他测试的库/前缀。
  process.stdout.write(`M1隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const n6 = support.runtime.assembly.invariant("docs.N6");
    expect(n6).toMatchObject({ code: "docs.N6", modes: ["full"], heal: "heal_and_alert" });
    expect(n6?.run).toBeTypeOf("function");
    expect(support.runtime.assembly.invariants.find((check) => check.code === "docs.N6")).toBe(n6);
    const report = await runM1Chain({
      api: createM1Api(support),
      support,
      say: (message) => process.stdout.write(`M1：${message}\n`),
    });
    expect(report.episodeCount).toBe(20);
    expect(report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(report.invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: 0 });
    expect(report.invariants.checksRun).toBeGreaterThan(0);
    expect(report.invariants.checksRun).toBe(
      support.runtime.assembly.invariants.filter((check) => check.modes.includes("full")).length,
    );
    process.stdout.write(
      `M1 主链完成：20集、扣减${report.chargePoints}积分、可用${report.spendablePoints}积分、不变量${report.invariants.checksRun}项零违规\n`,
    );
  } finally {
    await support.close();
  }
  expect(
    performance.now() - started,
    "装配、迁移、种子、主链、不变量与清理总墙钟",
  ).toBeLessThanOrEqual(90_000);
}, 90_000);
