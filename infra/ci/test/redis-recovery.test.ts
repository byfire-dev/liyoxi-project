import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers.js";

interface Facts {
  container: { id: string; pid: number; restarts: number; startedAt: string; running: boolean };
  lease: { holder: string; acquiredAt: string; heartbeatAt: string; ageSeconds: number };
  event: {
    publishedAt: string | null;
    deliveries: { subscriber: string; status: string; consumedAt: string | null }[];
  };
  timer: { status: string; firedAt: string | null; result: unknown };
}
const { waitForRedisRecovery, LOG_ROTATION, RECOVERY_LIMIT_MS } = (await import(
  pathToFileURL(join(repoRoot, "infra/deploy/redis-recovery.mjs")).href
)) as {
  LOG_ROTATION: Record<string, { size: string; files: string; mib: number }>;
  RECOVERY_LIMIT_MS: number;
  waitForRedisRecovery: (options: {
    before: Facts;
    flushedAt: number;
    subscribers: string[];
    read: () => Promise<Facts>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  }) => Promise<{ elapsedMs: number }>;
};
const ID = "a".repeat(64);
const project = "lyxrh-aabbcc";
const step = join(repoRoot, "infra/deploy/node-step.sh");
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** 真 bash；Docker 只替换命令协议，无 daemon、真实 Redis 或密钥。 */
function flush(
  options: {
    args?: string[];
    enabled?: string;
    freeze?: string;
    identity?: string;
    id?: string;
    reply?: string;
    fail?: string;
  } = {},
) {
  const temp = makeTempDir("lyx-redis-flush-");
  cleanups.push(temp.cleanup);
  writeFileSync(join(temp.dir, "release.env"), "LYX_TAG=local\n");
  writeFileSync(
    join(temp.dir, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >>"$REDIS_TEST_DIR/calls"
case "$1" in
  compose) [ "$REDIS_TEST_FAIL" != compose ] || exit 31; printf '%s\\n' "$REDIS_TEST_ID" ;;
  inspect) [ "$REDIS_TEST_FAIL" != inspect ] || exit 32; printf '%s\\n' "$REDIS_TEST_IDENTITY" ;;
  exec) [ "$REDIS_TEST_FAIL" != exec ] || exit 33; printf '%s\\n' "$REDIS_TEST_REPLY" ;;
  *) exit 34 ;;
esac
`,
  );
  chmodSync(join(temp.dir, "docker"), 0o755);
  const result = spawnSync("bash", [step, ...(options.args ?? ["redis-flush", project])], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("LYX_") && key !== "SSH_ORIGINAL_COMMAND" && key !== "STG_FREEZE",
        ),
      ),
      PATH: `${temp.dir}:${process.env.PATH ?? ""}`,
      LYX_NODE_HOME: temp.dir,
      LYX_NODE_PROJECT: project,
      LYX_NODE_PREFIX: project,
      LYX_NODE_PROVIDERS: "",
      LYX_REDIS_FLUSH_ENABLED: options.enabled ?? "true",
      STG_FREEZE: options.freeze ?? "false",
      REDIS_TEST_DIR: temp.dir,
      REDIS_TEST_ID: options.id ?? ID,
      REDIS_TEST_IDENTITY:
        options.identity ??
        `${ID}|/${project}-redis|true|${project}|redis|${join(repoRoot, "infra/compose/node.yml")}|False|0`,
      REDIS_TEST_REPLY: options.reply ?? "OK",
      REDIS_TEST_FAIL: options.fail ?? "",
    },
  });
  if (result.error) throw result.error;
  return {
    ...result,
    calls: existsSync(join(temp.dir, "calls"))
      ? readFileSync(join(temp.dir, "calls"), "utf8").trim().split("\n")
      : [],
  };
}

const at = Date.parse("2026-10-15T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const subscribers = [
  "approval.onCalendarImported",
  "staff.onCalendarImported",
  "media.onCalendarImported",
];
function before(): Facts {
  return {
    container: {
      id: "worker-id",
      pid: 1234,
      restarts: 0,
      startedAt: iso(at - 60_000),
      running: true,
    },
    lease: {
      holder: "worker-1234",
      acquiredAt: iso(at - 60_000),
      heartbeatAt: iso(at - 1_000),
      ageSeconds: 1,
    },
    event: { publishedAt: null, deliveries: [] },
    timer: { status: "scheduled", firedAt: null, result: null },
  };
}
function recovered(): Facts {
  const fact = before();
  fact.lease.heartbeatAt = iso(at + 10_000);
  fact.event = {
    publishedAt: iso(at + 1_000),
    deliveries: subscribers.map((subscriber) => ({
      subscriber,
      status: "done",
      consumedAt: iso(at + 2_000),
    })),
  };
  fact.timer = { status: "fired", firedAt: iso(at + 20_000), result: { checked: 1 } };
  return fact;
}

describe("W2-27a 精确轮转与自有 Redis 恢复", () => {
  it("六容器真实配置为390MiB，清空与完整演练默认均关闭", () => {
    const source = readFileSync(join(repoRoot, "infra/compose/node.yml"), "utf8");
    const expected = {
      postgres: "small-logging",
      redis: "small-logging",
      mediatool: "small-logging",
      api: "logging",
      worker: "logging",
      gateway: "logging",
    };
    for (const [service, anchor] of Object.entries(expected)) {
      const block = new RegExp(
        `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^networks:)`,
        "m",
      ).exec(source)?.[1];
      expect(block, service).toContain(`logging: *${anchor}`);
      expect(LOG_ROTATION[service]).toEqual(
        anchor === "logging"
          ? { size: "20m", files: "5", mib: 100 }
          : { size: "10m", files: "3", mib: 30 },
      );
    }
    expect(source).toMatch(
      /x-small-logging: &small-logging\n {2}driver: json-file\n {2}options:\n {4}max-size: 10m\n {4}max-file: "3"/,
    );
    expect(Object.values(LOG_ROTATION).reduce((sum, row) => sum + row.mib, 0)).toBe(390);
    expect(readFileSync(join(repoRoot, "infra/compose/env/stg.env"), "utf8")).toContain(
      "LYX_REDIS_FLUSH_ENABLED=false",
    );
    expect(readFileSync(join(repoRoot, "infra/deploy/rehearse.mjs"), "utf8")).toContain(
      '"redis-flush": { type: "boolean", default: false }',
    );
    expect(RECOVERY_LIMIT_MS).toBe(120_000);
  });

  it("未明确开启/冻结/项目与容器身份错误均零exec，不会清共享开发Redis", () => {
    for (const options of [
      { enabled: "false" },
      { freeze: "true" },
      { freeze: "" },
      { args: ["redis-flush", "liyoxi"] },
      { args: ["redis-flush", "../other"] },
      { args: ["redis-flush", project, "extra"] },
      { id: `${ID}\n${ID}` },
      {
        identity: `${ID}|/lyx-redis|true|liyoxi|redis|${join(repoRoot, "infra/compose/local.yml")}|False|1`,
      },
    ]) {
      const result = flush(options);
      expect(result.status, JSON.stringify(options)).not.toBe(0);
      expect(result.calls.some((call) => call.startsWith("exec "))).toBe(false);
    }
  });

  it("合法目标只按核定ID清DB0、口令不入argv；协议/命令失败保持失败", () => {
    const result = flush();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls[0]).toContain(`compose -p ${project}`);
    expect(result.calls[1]).toContain(`inspect -f`);
    const exec = result.calls.find((call) => call.startsWith("exec "))!;
    expect(exec).toContain(`exec ${ID} timeout 10 sh -c`);
    expect(exec).toContain("REDISCLI_AUTH=");
    expect(exec).toContain("/run/secrets/redis-auth.conf");
    expect(exec).toContain("redis-cli --no-auth-warning -n 0 FLUSHDB SYNC");
    expect(exec).not.toContain("FLUSHALL");
    expect(exec).not.toContain(" -a ");
    for (const options of [{ reply: "ERR no" }, { fail: "exec" }, { fail: "inspect" }])
      expect(flush(options).status).not.toBe(0);
  });

  it("真实消费者非空且全完成+timer fired+原PID续租；未知/重启/部分完成/120秒边界不能伪绿", async () => {
    const run = async (facts: Facts, elapsed = 20_000) => {
      let now = at + elapsed;
      return waitForRedisRecovery({
        before: before(),
        flushedAt: at,
        subscribers,
        read: async () => facts,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
    };
    await expect(run(recovered())).resolves.toEqual(expect.objectContaining({ elapsedMs: 20_000 }));
    const cases: Facts[] = [];
    const pid = recovered();
    pid.container.pid++;
    cases.push(pid);
    const restarted = recovered();
    restarted.container.restarts++;
    cases.push(restarted);
    const takeover = recovered();
    takeover.lease.acquiredAt = iso(at + 1);
    cases.push(takeover);
    const stale = recovered();
    stale.lease.ageSeconds = 30;
    cases.push(stale);
    const empty = recovered();
    empty.event.deliveries = [];
    cases.push(empty);
    const partial = recovered();
    partial.event.deliveries[0]!.status = "retry";
    cases.push(partial);
    const old = recovered();
    old.event.deliveries[0]!.consumedAt = iso(at - 1);
    cases.push(old);
    const skipped = recovered();
    skipped.timer.status = "skipped";
    cases.push(skipped);
    const noResult = recovered();
    noResult.timer.result = null;
    cases.push(noResult);
    for (const facts of cases) await expect(run(facts)).rejects.toThrow();
    await expect(run(recovered(), 120_000)).rejects.toThrow("120 秒");
    let now = at;
    await expect(
      waitForRedisRecovery({
        before: before(),
        flushedAt: at,
        subscribers,
        read: async () => {
          now = at + 120_001;
          return recovered();
        },
        now: () => now,
        sleep: async () => {},
      }),
    ).rejects.toThrow("120 秒");
    await expect(
      waitForRedisRecovery({
        before: before(),
        flushedAt: at,
        subscribers,
        read: async () => {
          throw new Error("unknown facts");
        },
        now: () => at,
        sleep: async () => {},
      }),
    ).rejects.toThrow("unknown facts");
  });
});
