// 每条命令拥有新隔离scope；命令内部同库重放原意图，最后自然清理。
import assert from "node:assert/strict";
import { createM5Support, verifyM5DemoReplay } from "@liyoxi/services/testing";
import type { M5DemoReplayResult } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM5Chain } from "./m5-runner.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    say(
      "pnpm demo:m5：仅APP_ENV=test本机新隔离库；真实HTTP订单交付链、同库原意图重放零新增，最后清理。",
    );
    return;
  }
  if (args.length) throw new Error("M5演示只接受--help");
  // 在任何支架/数据库创建前拒绝prod、production、local及未声明环境。
  if (process.env.APP_ENV !== "test") {
    console.error("M5演示仅接受APP_ENV=test；未创建隔离资源。");
    process.exitCode = 1;
    return;
  }
  const started = performance.now();
  const support = await createM5Support();
  let report: Awaited<ReturnType<typeof runM5Chain>>;
  let replay: M5DemoReplayResult | undefined;
  try {
    say("M5隔离演示：广告、订购、样片修改、授权、补发和异人取消；外部能力使用公开测试材料。");
    report = await runM5Chain({
      api: createM1Api(support),
      support,
      async afterCore(context) {
        replay = await verifyM5DemoReplay(support, context);
        say("同一隔离范围第二遍：业务新增0，完整字典保留。");
      },
    });
  } finally {
    await support.close();
  }
  assert.ok(replay, "M5演示必须实际执行同库第二遍");
  assert.ok(performance.now() - started <= 90_000, "M5演示含自然清理不得超过90秒");
  // 固定白名单，不展开业务/员工ID、会话、环境、接口原文或未来追加的report字段。
  say(
    `M5演示结果：${JSON.stringify({
      episodeCount: report.episodeCount,
      replay: { inserted: replay.inserted, dictionaryPreserved: replay.dictionaryPreserved },
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
  // 原始错误可能包含连接、口令、签名URL或完整响应；命令只给固定脱敏失败。
  console.error("M5演示失败，本轮资源已进入清理；用e2e:m5查看脱敏断言。");
  process.exitCode = 1;
});
