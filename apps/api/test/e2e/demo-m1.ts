// W1-21：与接口测试共用主路径。缺省只在本轮新测试库运行；--stack 只播种手验库。
import { createNotices, createRuntime, loadEnv, runDemoSeed, security } from "@liyoxi/services";
import { createM1Support } from "@liyoxi/services/testing";

import { createM1Api } from "./in-process.js";
import { runM1Chain } from "./runner.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function seedStack(): Promise<void> {
  const env = loadEnv();
  const target = new URL(env.DATABASE_URL);
  if (
    env.APP_ENV !== "local" ||
    target.pathname !== "/lyx_stack" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  ) {
    throw new Error("M1 --stack 只接受 APP_ENV=local 的本机 lyx_stack 库");
  }
  const runtime = createRuntime({
    entry: "worker",
    env: { ...env, LOG_LEVEL: "warn" },
    version: "m1-demo",
  });
  try {
    if ((await runtime.config.params.get("order.start_delay_minutes")) !== 0) {
      throw new Error("M1 演示要求开工延迟为 0，现有参数保持不变");
    }
    const report = await runDemoSeed({
      tx: runtime.tx,
      clock: runtime.clock,
      keyring: security.loadKeyring(env),
      flow: runtime.flow,
      appEnv: env.APP_ENV,
      media: runtime.media,
      content: runtime.content,
      notices: createNotices({ clock: runtime.clock, events: runtime.events }),
      billing: { assembly: runtime.assembly, bizNo: runtime.bizNo },
      params: runtime.config.params,
    });
    say(`M1 手验种子：新增 ${report.inserted} 行；保留 lyx_stack，按演示手册继续。`);
    for (const member of report.staff) {
      if (member.activation) {
        say(`新员工 ${member.name}（工号 ${member.staffNo}）：激活码 ${member.activation.code}`);
      }
    }
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    say("pnpm demo:m1：新隔离库重放七段接口主路径，结束后仅清理本轮资源。");
    say("pnpm demo:m1 --stack：只为本机 lyx_stack 播种，保留已有数据供手验。");
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--stack")) {
    throw new Error("M1 演示只接受 --stack 或 --help");
  }
  if (args[0] === "--stack") {
    await seedStack();
    return;
  }
  const support = await createM1Support({});
  try {
    say("M1 演示开始：本轮新建隔离库，全部外部能力使用测试替身。");
    const report = await runM1Chain({
      api: createM1Api(support),
      support,
      say: (message) => say(message),
    });
    say(
      `M1 结果：${JSON.stringify({
        episodes: report.episodeCount,
        chargePoints: report.chargePoints,
        spendablePoints: report.spendablePoints,
        final: report.final,
        invariants: report.invariants,
      })}`,
    );
    say("M1 演示完成：主路径已上线，全量不变量检查通过。");
  } finally {
    await support.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  // 驱动错误可能带连接串；只输出本命令自己生成的步骤诊断。
  console.error(
    message.startsWith("M1 ") && !message.includes("://")
      ? message
      : "M1 演示失败，本轮资源已进入清理。",
  );
  process.exitCode = 1;
});
