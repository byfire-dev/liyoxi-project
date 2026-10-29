// 每次命令新建隔离scope；同库第二遍复用原资金意图，结束沿原close收尾。
import assert from "node:assert/strict";
import { createM4Support, verifyM4DemoReplay } from "@liyoxi/services/testing";
import type { M4DemoReplayContext, M4DemoReplayResult } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM4Chain } from "./m4-runner.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    say("pnpm demo:m4：仅APP_ENV=test本机新隔离库；真实HTTP资金链、同scope重放零新增，最后清理。");
    return;
  }
  if (args.length) throw new Error("M4演示只接受--help");
  // 在任何支架/数据库创建前拒绝prod、production、local及未声明环境。
  if (process.env.APP_ENV !== "test") {
    console.error("M4演示仅接受APP_ENV=test；未创建隔离资源。");
    process.exitCode = 1;
    return;
  }
  const started = performance.now();
  const support = await createM4Support();
  let report: Awaited<ReturnType<typeof runM4Chain>>;
  let replay: M4DemoReplayResult | undefined;
  try {
    say("M4隔离演示：真实HTTP付款、两名财务调整与延长、退款；外部渠道仅用公开替身。");
    report = await runM4Chain({
      api: createM1Api(support),
      support,
      async afterCore(context: M4DemoReplayContext) {
        replay = await verifyM4DemoReplay(support, context);
        say("同一隔离范围第二遍：业务新增0，完整字典保留。");
      },
    });
  } finally {
    await support.close();
  }
  assert.ok(replay, "M4演示必须实际执行同scope第二遍");
  assert.ok(performance.now() - started <= 90_000, "M4演示含自然清理不得超过90秒");
  assert.match(report.paymentOrderNo, /^[A-Z][A-Z0-9-]{1,63}$/);
  assert.match(report.refundRequestNo, /^[A-Z][A-Z0-9-]{1,63}$/);
  // 只输出白名单业务摘要，不展开员工、会话、环境、接口原文或未来追加的report字段。
  say(
    `M4演示结果：${JSON.stringify({
      paymentOrderNo: report.paymentOrderNo,
      refundRequestNo: report.refundRequestNo,
      paidFen: report.paidFen,
      refundedFen: report.refundedFen,
      replay,
      invariants: {
        status: report.invariants.status,
        checksRun: report.invariants.checksRun,
        violationsFound: report.invariants.violationsFound,
        errors: report.invariants.errors,
      },
    })}`,
  );
}

main().catch(() => {
  // 原始驱动/断言错误可能带连接、口令、签名URL或完整响应，命令不回显。
  console.error("M4演示失败，本轮资源已进入清理；用e2e:m4查看脱敏断言。");
  process.exitCode = 1;
});
