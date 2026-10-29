import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
it("真实bash窄分组协议只转发固定参数，旧分钟形式与只读容器边界保留", () => {
  const temp = makeTempDir("lyx-review-log-protocol-");
  cleanup.push(temp.cleanup);
  writeFileSync(join(temp.dir, "release.env"), "LYX_TAG=sha-0123456789ab\n");
  const docker = join(temp.dir, "docker");
  writeFileSync(
    docker,
    `#!/bin/bash
printf '%s\\n' "$*" >> "$LYX_LOG_PROTOCOL_CALLS"
case "$1" in
  image) printf '%s\\n' 'sha256:${"a".repeat(64)}' ;;
  logs) printf '%s\\n' '{}' ;;
  run) cat >/dev/null; printf '%s\\n' '{"fixture":true}' ;;
  *) exit 45 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  const callsFile = join(temp.dir, "calls");
  const run = (args: string[]) =>
    spawnSync("bash", [join(repoRoot, "infra/deploy/node-step.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temp.dir}:${process.env.PATH}`,
        LYX_SRC: repoRoot,
        LYX_NODE_HOME: temp.dir,
        LYX_NODE_SUPERVISOR: "compose",
        LYX_NODE_PROVIDERS: "",
        LYX_LOG_PROTOCOL_CALLS: callsFile,
      },
    });
  for (const args of [
    ["0"],
    ["1441"],
    ["1", "--by-env-version", "weapp-v1.2.3"],
    ["1", "--by-env-version", "sha-0123456789ab;id"],
    ["1", "--other", "sha-0123456789ab"],
    ["1", "--by-env-version", "sha-0123456789ab", "extra"],
  ])
    expect(run(["log-stats", ...args]).status).toBe(2);
  expect(run(["log-stats", "60"]).status).toBe(0);
  expect(run(["log-stats", "1440", "--by-env-version", "sha-0123456789ab"]).status).toBe(0);
  const calls = readFileSync(callsFile, "utf8");
  expect(calls).toContain("/helper/log-stats.mjs stats 60\n");
  expect(calls).toContain(
    "/helper/log-stats.mjs stats 1440 --by-env-version --client-version sha-0123456789ab",
  );
  expect(calls).toContain("--tail 100001");
  expect(calls).toContain("--network none --read-only --user 65534:65534");
  expect(calls).not.toContain("/run/secrets");
});
