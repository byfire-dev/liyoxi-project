import { main } from "./orchestrate.mjs";
import { prepare } from "./workflow-prepare.mjs";
try {
  const env = process.env;
  if (env.ROLLBACK_TAG && !/^sha-[a-f0-9]{12}$/.test(env.ROLLBACK_TAG)) throw Error("回滚标签无效");
  if (
    !["true", "false"].includes(env.ROLLBACK_FORCE) ||
    (env.ROLLBACK_FORCE === "true" && !env.ROLLBACK_REASON?.trim()) ||
    (env.ROLLBACK_REASON?.length ?? 0) > 256
  )
    throw Error("越过标记或理由无效");
  prepare(env);
  const args = [
    "--rollback",
    "--node",
    `${env.STG_NODE_USER}@${env.STG_NODE_HOST}`,
    "--summary",
    `${env.RUNNER_TEMP}/rollback-summary.json`,
    "--probe-config",
    `${env.RUNNER_TEMP}/probe-config.json`,
    "--probe-summary",
    `${env.RUNNER_TEMP}/probe-summary.json`,
  ];
  if (env.ROLLBACK_TAG) args.push("--tag", env.ROLLBACK_TAG);
  if (env.ROLLBACK_FORCE === "true") args.push("--force", "--reason", env.ROLLBACK_REASON);
  process.exitCode = await main(args, env);
} catch {
  console.error("预发回滚配置或执行失败");
  process.exitCode = 2;
}
