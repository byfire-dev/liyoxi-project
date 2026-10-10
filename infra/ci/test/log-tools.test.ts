import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot } from "./helpers.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ID = "019a03ba-1111-7222-8333-444444444444";
const OTHER = "019a03ba-1111-7222-8333-444444444445";
const DIGEST = `sha256:${"a".repeat(64)}`;
const helper = join(repoRoot, "infra/deploy/log-stats.mjs");
interface LogTools {
  LIMITS: { bytes: number; lineBytes: number; rows: number; matches: number };
  readLogs: (
    input: AsyncIterable<Buffer | string>,
    mode: string,
    value: string,
    now?: number,
  ) => Promise<string>;
}
const { LIMITS, readLogs } = (await import(pathToFileURL(helper).href)) as LogTools;
const step = join(repoRoot, "infra/deploy/node-step.sh");
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const line = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    time: "2026-10-10T11:59:30Z",
    path: "/api/v1/m/catalog",
    status: 200,
    request_time: 0.2,
    ...fields,
  });
const input = (lines: string[]) => Readable.from([lines.join("\n") + (lines.length ? "\n" : "")]);
const stats = async (lines: string[], minutes = "1") =>
  JSON.parse(await readLogs(input(lines), "stats", minutes, NOW));

/** 真 bash 与真 Node helper；仅 Docker 命令协议替身，不触碰本机 daemon。 */
function nodeStep(args: string[], logs = "", failure = "", ssh = false) {
  const temp = makeTempDir("lyx-log-tools-");
  cleanups.push(temp.cleanup);
  const source = temp.dir;
  writeFileSync(join(source, "release.env"), "LYX_TAG=sha-0123456789ab\n");
  writeFileSync(join(source, "input"), logs);
  writeFileSync(
    join(source, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >>"$LOG_TEST_DIR/calls"
case "$1" in
  image) [ "$LOG_TEST_FAIL" != image ] || exit 41; printf '%s\\n' '${DIGEST}' ;;
  logs) cat "$LOG_TEST_DIR/input"; [ "$LOG_TEST_FAIL" != logs ] || exit 42 ;;
  run) [ "$LOG_TEST_FAIL" != run ] || exit 43
    while [ "$1" != /helper/log-stats.mjs ]; do shift; done
    shift
    exec "$LOG_TEST_NODE" "$LOG_TEST_HELPER" "$@" ;;
  *) exit 44 ;;
esac
`,
  );
  chmodSync(join(source, "docker"), 0o755);
  for (const [name, script] of Object.entries({
    id: '#!/bin/bash\nprintf "1001\\n"\n',
    sudo: '#!/bin/bash\nprintf "sudo %s\\n" "$*" >>"$LOG_TEST_DIR/calls"\n',
  })) {
    writeFileSync(join(source, name), script);
    chmodSync(join(source, name), 0o755);
  }
  const result = spawnSync("bash", [step, ...(ssh ? [] : args)], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("LYX_") && key !== "SSH_ORIGINAL_COMMAND",
        ),
      ),
      PATH: `${source}:${process.env.PATH ?? ""}`,
      LYX_NODE_HOME: source,
      LOG_TEST_DIR: source,
      LOG_TEST_NODE: process.execPath,
      LOG_TEST_HELPER: helper,
      LOG_TEST_FAIL: failure,
      ...(ssh ? { SSH_ORIGINAL_COMMAND: args.join(" ") } : {}),
    },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(join(source, "calls"))
      ? readFileSync(join(source, "calls"), "utf8").trim().split("\n")
      : [],
  };
}

describe("gateway JSON 流的完整统计", () => {
  it("手算 nearest-rank P95、5xx率；精确包含起止边界并排除明确探活", async () => {
    const samples = Array.from({ length: 20 }, (_, i) =>
      line({ request_time: i + 1, status: i < 2 ? 500 : 200 }),
    );
    const result = await stats([
      ...samples,
      line({ time: "2026-10-10T11:59:00Z", request_time: 0 }),
      line({ time: "2026-10-10T12:00:00Z", request_time: 21 }),
      line({ path: "/health", status: 503 }),
      line({ path: "/healthz" }),
      line({ path: "/readyz" }),
    ]);
    expect(result).toEqual({
      windowStart: "2026-10-10T11:59:00.000Z",
      windowEnd: "2026-10-10T12:00:00.000Z",
      minutes: 1,
      samples: 22,
      errors5xx: 2,
      rate5xx: 2 / 22,
      p95Seconds: 20,
      excluded: 3,
      badLines: 0,
      outsideWindow: 0,
      inputRows: 25,
    });
  });

  it("0样本的P95与比率为null，未来/过期分列，/health/detail不是探活", async () => {
    expect(await stats([])).toMatchObject({ samples: 0, rate5xx: null, p95Seconds: null });
    expect(
      await stats([
        line({ time: "2026-10-10T11:58:59.999Z" }),
        line({ time: "2026-10-10T12:00:00.001Z" }),
        line({ path: "/health/detail" }),
      ]),
    ).toMatchObject({ samples: 1, outsideWindow: 2, excluded: 0 });
  });

  it("合法时区/小数/零时长，坏JSON/时间/状态/有限非负数逐行计数且无原文", async () => {
    const invalid = [
      "secret-not-json",
      "null",
      "[]",
      line({ time: "2026-02-30T11:59:30Z" }),
      line({ time: "2026-10-10T25:59:30Z" }),
      line({ time: "2026-10-10" }),
      line({ status: "500" }),
      line({ status: 600 }),
      line({ status: 199.5 }),
      line({ request_time: -1 }),
      line({ request_time: null }),
      line({ request_time: "Infinity" }),
      '{"time":"2026-10-10T11:59:30Z","path":"/","status":200,"request_time":1e999}',
      line({ path: null }),
    ];
    const result = await stats([
      line({ time: "2026-10-10T19:59:30.125+08:00", request_time: 0 }),
      ...invalid,
    ]);
    expect(result).toMatchObject({ samples: 1, badLines: invalid.length, p95Seconds: 0 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("流分块/跨UTF8边界与末行没有换行仍完整", async () => {
    const bytes = Buffer.from(line({ path: "/剧目" }));
    const text = await readLogs(
      Readable.from([...bytes].map((byte) => Buffer.from([byte]))),
      "stats",
      "1",
      NOW,
    );
    expect(JSON.parse(text)).toMatchObject({ samples: 1, inputRows: 1, badLines: 0 });
  });

  it.each(["0", "01", "-1", "1.5", "1441", "1;id", "Infinity"])(
    "严格拒绝分钟 %s",
    async (minutes) => {
      await expect(readLogs(input([]), "stats", minutes, NOW)).rejects.toThrow("分钟");
    },
  );

  it("1440合法；非法统计时刻/模式明确失败", async () => {
    expect(await stats([], "1440")).toMatchObject({ minutes: 1440 });
    await expect(readLogs(input([]), "stats", "1", Number.NaN)).rejects.toThrow("时刻");
    await expect(readLogs(input([]), "other", "1", NOW)).rejects.toThrow("只接受");
  });

  it("单行/行数/总字节上限均失败，不输出貌似完整结果", async () => {
    await expect(
      readLogs(Readable.from(["x".repeat(LIMITS.lineBytes + 1)]), "stats", "1", NOW),
    ).rejects.toThrow("单行");
    await expect(
      readLogs(Readable.from(["{}\n".repeat(LIMITS.rows + 1)]), "stats", "1", NOW),
    ).rejects.toThrow("行数");
    async function* many() {
      for (let i = 0; i < 33; i++) yield Buffer.from((" ".repeat(1023) + "\n").repeat(1024));
    }
    await expect(readLogs(Readable.from(many()), "stats", "1", NOW)).rejects.toThrow("总字节");
  });
});

describe("请求编号有限读取", () => {
  it("只按顶层reqId/request_id精确匹配，不按正文/子串匹配；保留原脱敏行", async () => {
    const rows = [
      JSON.stringify({ reqId: ID, msg: "脱敏***" }),
      JSON.stringify({ request_id: ID.toUpperCase(), msg: "gateway" }),
      JSON.stringify({ reqId: OTHER, body: ID }),
      JSON.stringify({ reqId: `${ID}x` }),
      "not-json",
    ];
    expect(await readLogs(input(rows), "logs", ID)).toBe(rows.slice(0, 2).join("\n") + "\n");
    expect(await readLogs(input(rows), "logs", "019a03ba-9999-7222-8333-444444444444")).toBe("");
  });

  it("请求编号/匹配行/扫描行上限严格拒绝", async () => {
    await expect(readLogs(input([]), "logs", `${ID};id`)).rejects.toThrow("UUID");
    await expect(
      readLogs(input(Array.from({ length: 201 }, () => JSON.stringify({ reqId: ID }))), "logs", ID),
    ).rejects.toThrow("匹配行");
    await expect(readLogs(Readable.from(["{}\n".repeat(5001)]), "logs", ID)).rejects.toThrow(
      "行数",
    );
  });
});

describe("node-step只增受限logs/log-stats", () => {
  it.each(["postgres", "redis", "mediatool", "api", "worker", "gateway"])(
    "固定服务 %s：60分钟/5001输入行/200匹配上界",
    (service) => {
      const row = JSON.stringify({ reqId: ID, msg: "safe***" });
      const result = nodeStep(["logs", service, ID], row + "\n");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(row + "\n");
      expect(result.calls[1]).toBe(`logs --since 60m --tail 5001 lyx-${service}`);
      expect(result.calls[2]).toContain(`/helper/log-stats.mjs logs ${ID}`);
    },
  );

  it("gateway统计通过只读helper/imageID：无网络/权限/密钥挂载，不依赖宿主Node", () => {
    const result = nodeStep(["log-stats", "5"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ minutes: 5, samples: 0, p95Seconds: null });
    expect(result.calls[0]).toBe("image inspect -f {{.Id}} liyoxi/server:sha-0123456789ab");
    expect(result.calls[1]).toBe("logs --since 5m --tail 100001 lyx-gateway");
    expect(result.calls).toHaveLength(3);
    const run = result.calls[2] ?? "";
    for (const token of [
      "--rm -i --pull never --network none --read-only",
      "--user 65534:65534",
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--memory 128m --cpus 0.5 --pids-limit 32 --log-driver none",
      "target=/helper/log-stats.mjs,readonly",
      `--entrypoint node ${DIGEST}`,
    ])
      expect(run).toContain(token);
    expect(run).not.toMatch(/--env|--privileged|secrets|docker.sock|--network host/);
  });

  it.each(
    [
      ["logs", "gateway", `${ID};id`],
      ["logs", "nginx", ID],
      ["logs", "gateway"],
      ["logs", "gateway", ID, "extra"],
      ["log-stats", "0"],
      ["log-stats", "01"],
      ["log-stats", "1441"],
      ["log-stats", "1;id"],
      ["log-stats", "1", "extra"],
    ].map((args) => ({ args })),
  )("参数注入/错误 $args在调用Docker前拒绝", ({ args }) => {
    const result = nodeStep(args);
    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });

  it("强制SSH只接受同一窄协议，不能带shell/内部步骤", () => {
    const ok = nodeStep(["logs", "api", ID], "", "", true);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.calls).toEqual([`sudo -n -- ${step} logs api ${ID}`]);
    for (const args of [
      ["logs", "api", `${ID};id`],
      ["log-stats", "1", "&&", "id"],
    ]) {
      const result = nodeStep(args, "", "", true);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
    }
  });

  it.each(["image", "logs", "run"])("Docker %s失败传播且不输出部分统计/日志", (failure) => {
    const result = nodeStep(["log-stats", "1"], line() + "\n", failure);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("helper超限传播，无部分匹配输出；原入口未扩大到任意端点", () => {
    const result = nodeStep(
      ["logs", "api", ID],
      (JSON.stringify({ reqId: ID }) + "\n").repeat(201),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(nodeStep(["logs", "https://example.invalid", ID]).calls).toEqual([]);
  });
});
