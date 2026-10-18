// 默认每次命令拥有新隔离库；在同库执行两遍演示意图证明幂等，最后自然清理。
import { createM3Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM3Chain } from "./m3-runner.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    say(
      "pnpm demo:m3：APP_ENV=test、本机PG/Redis；新隔离库内正式接口演示及同意图第二遍零新增，结束清理。",
    );
    return;
  }
  if (args.length) throw new Error("M3 演示仅接受 --help，不接受目标业务库或生产模式");
  const support = await createM3Support();
  try {
    say(`M3隔离资源：${support.databaseName}；${support.redisPrefix}`);
    const report = await runM3Chain({ api: createM1Api(support), support, say });
    say(
      `M3演示结果：${JSON.stringify({
        episodes: report.episodeCount,
        final: report.final,
        invariants: report.invariants,
        replay: report.replay,
        usages: report.usages.map((one) => ({
          referenceCount: one.referenceCount,
          adoptedCount: one.adoptedCount,
        })),
      })}`,
    );
  } finally {
    await support.close();
  }
}
main().catch(() => {
  // 不回显可能包含数据库连接、签名URL、口令或完整接口响应的驱动错误。
  console.error("M3 演示失败，本轮资源已进入清理；用 e2e:m3 查看脱敏断言。");
  process.exitCode = 1;
});
