// 只给可信、默认关闭的CI消费者使用；配置和冻结先于SSH凭据落盘。
import { mkdirSync, writeFileSync } from "node:fs";
import { validateTargets } from "../ci/probe-during-deploy.mjs";
import { fileURLToPath } from "node:url";
export function prepare(env) {
  if (env.STG_FREEZE === "true") throw Error("预发已冻结");
  if (
    !/^[a-z_][a-z0-9_-]*$/.test(env.STG_NODE_USER ?? "") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.STG_NODE_HOST ?? "") ||
    !env.SSH_PRIVATE_KEY ||
    !env.SSH_KNOWN_HOSTS
  )
    throw Error("SSH配置无效");
  const probes = validateTargets(JSON.parse(env.STG_PROBE_CONFIG ?? "null"));
  if (probes.length > 32) throw Error("持续探测目标过多");
  mkdirSync(`${env.HOME}/.ssh`, { recursive: true, mode: 0o700 });
  writeFileSync(`${env.HOME}/.ssh/id_ed25519`, env.SSH_PRIVATE_KEY, { mode: 0o600 });
  writeFileSync(`${env.HOME}/.ssh/known_hosts`, env.SSH_KNOWN_HOSTS, { mode: 0o600 });
  writeFileSync(`${env.RUNNER_TEMP}/probe-config.json`, JSON.stringify(probes));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    prepare(process.env);
  } catch {
    console.error("预发配置或冻结校验失败");
    process.exitCode = 2;
  }
}
