import { createM2Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM2Chain } from "./m2-runner.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "pnpm demo:m2：APP_ENV=test、本机隔离库；真实接口链与运输恢复，最后只清理本轮资源。\n",
    );
    return;
  }
  if (args.length) throw new Error("M2 演示只接受 --help");
  const at = performance.now(),
    support = await createM2Support();
  let report: Awaited<ReturnType<typeof runM2Chain>>;
  try {
    process.stdout.write(`M2隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
    report = await runM2Chain({
      api: createM1Api(support),
      support,
      say: (message) => process.stdout.write(`${message}\n`),
    });
  } finally {
    await support.close();
  }
  if (performance.now() - at > 90_000) throw new Error("M2 含清理主链超过90秒");
  process.stdout.write(`M2演示结果：${JSON.stringify(report)}\n`);
}
main().catch(() => {
  console.error("M2 演示失败，本轮资源已进入清理；用 e2e:m2 查看脱敏断言。");
  process.exitCode = 1;
});
