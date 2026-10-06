import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  main as recordMain,
  protectedVersions,
  validateRecord,
} from "../../deploy/node-record.mjs";
import type { ReleaseRecord } from "../../deploy/node-record.mjs";
import {
  createChannel,
  orchestrate,
  RELEASE_STEPS,
  ROLLBACK_STEPS,
} from "../../deploy/orchestrate.mjs";
import { makeTempDir, repoRoot } from "./helpers.js";

const VERSION = "sha-222222222222";
const OLD = "sha-111111111111";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ID = "019abcdef-0000-0000-0000-00000000000"; // 非 UUID 的输入由真实预检拒绝。
const ALERT = "019abcdef0ab-0000-0000-0000-00000000";
const P1 = "019abcdef-000-0000-0000-000000000000";
const UUID = "019abcde-f012-7000-8000-000000000001";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const temp = () => {
  const dir = makeTempDir("lyx-stg-release-");
  cleanups.push(dir.cleanup);
  return dir.dir;
};

function record(version = OLD, rollbackSafe = true) {
  return validateRecord({
    schemaVersion: 1,
    runId: "0".repeat(32),
    action: "release",
    version,
    previousVersion: null,
    startedAt: "2026-10-07T00:00:00.000Z",
    finishedAt: "2026-10-07T00:00:01.000Z",
    durationMs: 1000,
    result: "success",
    failedStep: null,
    onlineTouched: true,
    runtimeTouched: true,
    rollbackSafe,
    reason: "",
    overrideP1: [],
    p1: "unavailable",
    compatibility: "unavailable",
    imageDigests: { server: DIGEST, gateway: DIGEST, mediatool: DIGEST },
    steps: [],
  });
}

function channel(
  options: {
    fail?: string;
    current?: string;
    history?: ReturnType<typeof record>[];
    p1?: string[];
    malformed?: string;
    recordFail?: boolean;
  } = {},
) {
  const calls: Array<{ step: string; args: string[] }> = [];
  const run = (step: string, args: string[] = []) => {
    calls.push({ step, args });
    if (step === options.fail || (step === "record" && options.recordFail))
      return { status: 17, stdout: "", stderr: "故障" };
    let stdout = "";
    if (step === "facts")
      stdout = `LYX_CURRENT=${options.current ?? OLD}\n${(options.history ?? [record()]).map((row) => `LYX_RECORD=${JSON.stringify(row)}\n`).join("")}`;
    if (step === "preflight")
      stdout = `LYX_PREFLIGHT=${options.malformed ?? JSON.stringify({ p1: options.p1 ? "checked" : "unavailable", ids: options.p1 ?? [] })}\n`;
    if (step === "image-facts")
      stdout = ["server", "gateway", "mediatool"]
        .map((name) => `LYX_IMAGE=${name}|${DIGEST}\n`)
        .join("");
    return { status: 0, stdout, stderr: "" };
  };
  return { run, calls };
}

describe("预发发布编排与回滚", () => {
  it("真实 Node CLI 经假受限 SSH 调真 bash，固定顺序、摘要落盘和每步失败停止", () => {
    const dir = temp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls");
    const summary = join(dir, "summary.json");
    const markdown = join(dir, "summary.md");
    const ssh = `#!/bin/bash
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift; shift
step="$1"; shift
printf '%s\\n' "$step" >>"$LYX_CLI_CALLS"
[ "$step" != "\${LYX_CLI_FAIL:-}" ] || { printf '桩故障\\n' >&2; exit 17; }
case "$step" in
 facts) printf 'LYX_CURRENT=${OLD}\\n' ;;
 preflight) printf 'LYX_PREFLIGHT={"p1":"unavailable","ids":[]}\\n' ;;
 image-facts) printf 'LYX_IMAGE=server|${DIGEST}\\nLYX_IMAGE=gateway|${DIGEST}\\nLYX_IMAGE=mediatool|${DIGEST}\\n' ;;
 record) printf '%s' "$2" >"$LYX_CLI_RECORD" ;;
esac
`;
    writeFileSync(join(bin, "ssh"), ssh);
    chmodSync(join(bin, "ssh"), 0o755);
    const run = (fail = "") =>
      spawnSync(
        process.execPath,
        [
          join(repoRoot, "infra/deploy/orchestrate.mjs"),
          "--tag",
          VERSION,
          "--node",
          "deploy@fixture.invalid",
          "--summary",
          summary,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            STG_FREEZE: "false",
            GITHUB_STEP_SUMMARY: markdown,
            LYX_CLI_CALLS: calls,
            LYX_CLI_RECORD: join(dir, "record"),
            LYX_CLI_FAIL: fail,
          },
        },
      );
    expect(run().status).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "facts",
      "preflight",
      "pull",
      "image-facts",
      ...RELEASE_STEPS.slice(1),
      "record",
    ]);
    expect(JSON.parse(readFileSync(summary, "utf8"))).toMatchObject({
      result: "success",
      p1: "unavailable",
      version: VERSION,
    });
    expect(readFileSync(markdown, "utf8")).toContain(`release ${VERSION}`);
    for (const fail of RELEASE_STEPS) {
      writeFileSync(calls, "");
      expect(run(fail).status).toBe(1);
      const sequence = readFileSync(calls, "utf8").trim().split("\n");
      expect(sequence.slice(sequence.indexOf(fail) + 1)).toEqual(["record"]);
      expect(JSON.parse(readFileSync(summary, "utf8"))).toMatchObject({
        failedStep: fail,
        result: "failure",
      });
    }
  });
  it("固定步骤顺序；同版本重跑；记录真实摘要与三类镜像摘要", () => {
    const mock = channel();
    for (let i = 0; i < 2; i++) {
      const result = orchestrate({ tag: VERSION }, mock.run);
      expect(result.exitCode).toBe(0);
      expect(result.onlineTouched).toBe(true);
      expect(result.runtimeTouched).toBe(true);
      expect(result.p1).toBe("unavailable");
      expect(result.imageDigests.server).toBe(DIGEST);
    }
    expect(mock.calls.slice(0, 16).map((row) => row.step)).toEqual([
      "facts",
      "preflight",
      "pull",
      "image-facts",
      ...RELEASE_STEPS.slice(1),
      "record",
    ]);
    const saved = mock.calls.find((row) => row.step === "record");
    expect(saved).toBeDefined();
    expect(JSON.parse(Buffer.from(saved!.args[1]!, "base64url").toString())).toMatchObject({
      result: "success",
      version: VERSION,
      previousVersion: OLD,
    });
  });
  it.each(["facts", "preflight", "image-facts", ...RELEASE_STEPS])(
    "%s 失败即止，记录停止点与线上是否已触碰",
    (fail) => {
      const mock = channel({ fail });
      const result = orchestrate({ tag: VERSION }, mock.run);
      expect(result.exitCode).toBe(1);
      expect(result.failedStep).toBe(fail);
      const stop = mock.calls.findIndex((row) => row.step === fail);
      expect(mock.calls.slice(stop + 1).map((row) => row.step)).toEqual(["record"]);
      expect(result.onlineTouched).toBe(
        RELEASE_STEPS.findIndex((step) => step === fail) >= RELEASE_STEPS.indexOf("migrate"),
      );
      expect(result.runtimeTouched).toBe(
        RELEASE_STEPS.findIndex((step) => step === fail) >= RELEASE_STEPS.indexOf("worker-swap"),
      );
    },
  );
  it("冻结、兼容失败、无理由越过均拒绝，线上未动；原始失败不被写记录失败盖掉", () => {
    for (const options of [
      { freeze: true },
      { compatibility: "failed" },
      { force: true },
      { overrideP1: [UUID] },
    ]) {
      const mock = channel();
      const result = orchestrate({ tag: VERSION, ...options }, mock.run);
      expect(result.failedStep).toBe("precheck");
      expect(result.onlineTouched).toBe(false);
      expect(mock.calls.map((row) => row.step)).toEqual(["record"]);
    }
    const mock = channel({ fail: "seed", recordFail: true });
    const result = orchestrate({ tag: VERSION }, mock.run);
    expect(result.failedStep).toBe("seed");
    expect(result.error).toContain("seed");
    expect(result.recordError).toContain("故障");
  });
  it("P1 默认挡住；只可明确越过所有实际 P1 且带理由；坏返回值拒绝", () => {
    const blocked = channel({ p1: [UUID] });
    expect(orchestrate({ tag: VERSION }, blocked.run)).toMatchObject({
      p1: "blocked",
      onlineTouched: false,
      exitCode: 1,
    });
    expect(blocked.calls.map((row) => row.step)).not.toContain("pull");
    expect(
      orchestrate(
        { tag: VERSION, overrideP1: [UUID], reason: "修复该告警" },
        channel({ p1: [UUID] }).run,
      ),
    ).toMatchObject({ p1: "overridden", exitCode: 0 });
    for (const malformed of [
      JSON.stringify({ p1: "checked", ids: [ID] }),
      JSON.stringify({ p1: "unavailable", ids: [UUID] }),
      JSON.stringify({ p1: "checked", ids: [], extra: true }),
    ])
      expect(orchestrate({ tag: VERSION }, channel({ malformed }).run).exitCode).toBe(1);
  });
  it("回滚缺省取上一条成功的不同版本，跳过失败与当前版重跑；先 api/gateway 后 worker", () => {
    const failed: ReleaseRecord = { ...record(VERSION), result: "failure", failedStep: "seed" };
    const mock = channel({ current: VERSION, history: [record(), record(VERSION), failed] });
    const result = orchestrate({ rollback: true }, mock.run);
    expect(result).toMatchObject({ version: OLD, exitCode: 0 });
    expect(mock.calls.map((row) => row.step)).toEqual([
      "facts",
      "preflight",
      "image-facts",
      ...ROLLBACK_STEPS,
      "record",
    ]);
    expect(mock.calls.map((row) => row.step)).not.toContain("pull");
    expect(
      mock.calls.filter((row) => ["migrate", "seed", "stage-assets"].includes(row.step)),
    ).toHaveLength(0);
  });
  it("不安全回滚需 force 与非空 reason；目标本地缺失在 stop 前拒绝", () => {
    const history = [record(), record(VERSION, false)];
    for (const options of [
      {},
      { force: true },
      { reason: "说明" },
      { force: true, reason: "  " },
    ]) {
      const mock = channel({ current: VERSION, history });
      expect(orchestrate({ rollback: true, ...options }, mock.run).exitCode).toBe(1);
      expect(mock.calls.map((row) => row.step)).not.toContain("api-stop");
    }
    const forced = channel({ current: VERSION, history });
    const result = orchestrate({ rollback: true, force: true, reason: "经核对后恢复" }, forced.run);
    expect(result).toMatchObject({ exitCode: 0, reason: "经核对后恢复" });
    const missing = channel({ current: VERSION, history, fail: "image-facts" });
    expect(orchestrate({ rollback: true, force: true, reason: "恢复" }, missing.run)).toMatchObject(
      { onlineTouched: false, exitCode: 1 },
    );
    expect(missing.calls.map((row) => row.step)).not.toContain("api-stop");
    const partial: ReleaseRecord = {
      ...record(VERSION, false),
      result: "failure",
      failedStep: "seed",
      runtimeTouched: false,
    };
    const afterPartial = channel({
      current: "sha-333333333333",
      history: [record(), partial, record("sha-333333333333")],
    });
    expect(orchestrate({ rollback: true, tag: OLD }, afterPartial.run).exitCode).toBe(1);
    expect(afterPartial.calls.map((row) => row.step)).not.toContain("api-stop");
  });
  it("受限通道拒绝选项、空白与命令替换，未发 SSH", () => {
    for (const node of ["-oProxyCommand=bad", "user@host;id", "root@$(id)", "user@host extra"])
      expect(() => createChannel({ node })).toThrow();
    const local = createChannel({ local: true });
    expect(() => local("pull", ["$(id)"])).toThrow();
  });
});

const FAKE_DOCKER = `#!/bin/bash
printf '%s\\n' "$*" >>"$LYX_FAKE_CALLS"
if [ -n "\${LYX_FAKE_FAIL:-}" ]; then case "$1 $2" in "$LYX_FAKE_FAIL"*) exit 17 ;; esac; fi
case "$1" in
 image)
  case "$2" in
   inspect) [ "\${LYX_FAKE_MISSING:-}" != 1 ] || exit 1; printf 'sha256:%064d\\n' 0 ;;
   ls) case "$*" in *'reference=liyoxi/server:'*) printf '%s\\n' "\${LYX_FAKE_IMAGES:-}" ;; esac ;;
  esac ;;
 inspect) printf 'running healthy\\n' ;;
 ps) printf '%s' "\${LYX_FAKE_STATE:-exited}" ;;
 create) printf 'fake-container\\n' ;;
 cp)
  case "$2" in *'/admin/'*) app=admin ;; *) app=portal ;; esac
  cp -R "$LYX_FAKE_ASSETS/$app/." "$3" ;;
 exec)
  case "$*" in
   *'SELECT to_regclass'*) printf '%s\\n' "\${LYX_FAKE_P1_TABLE:-t}" ;;
   *'SELECT coalesce(json_agg'*) printf '%s\\n' "\${LYX_FAKE_P1_IDS:-[]}" ;;
   *'%{http_code}'*)
     n=$(cat "$LYX_FAKE_COUNT" 2>/dev/null || printf 0); n=$((n+1)); printf '%s' "$n" >"$LYX_FAKE_COUNT"
     if [ "\${LYX_FAKE_READY:-}" = flaps ] && [ "$n" = 2 ]; then printf 503; elif [ "\${LYX_FAKE_READY:-}" = fail ]; then printf 503; else printf 200; fi ;;
   *'/health') printf '{"version":"%s","worker":"ok"}' "\${LYX_FAKE_VERSION:-sha-222222222222}" ;;
  esac ;;
 run)
  while [ "$#" -gt 0 ] && [ "$1" != /helper/node-record.mjs ]; do shift; done
  [ "$#" -gt 0 ] || exit 17
  shift
  node --input-type=module -e 'const m = await import(process.env.LYX_FAKE_HELPER); m.main(process.argv.slice(1), process.env.LYX_NODE_HOME + "/releases.log")' "$@" ;;
esac
`;

function fixture() {
  const dir = temp();
  const bin = join(dir, "bin");
  const home = join(dir, "node");
  const assets = join(dir, "assets");
  mkdirSync(bin);
  mkdirSync(home);
  for (const app of ["admin", "portal"]) {
    mkdirSync(join(assets, app), { recursive: true });
    writeFileSync(join(assets, app, "new-222.js"), "new");
  }
  const fake = (name: string, source: string) => {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  };
  fake("docker", FAKE_DOCKER);
  fake("systemctl", '#!/bin/bash\nprintf "systemctl %s\\n" "$*" >>"$LYX_FAKE_CALLS"\n');
  fake("sleep", "#!/bin/bash\nexit 0\n");
  fake("id", "#!/bin/bash\nprintf '0\\n'\n");
  fake(
    "date",
    '#!/bin/bash\nn=$(cat "$LYX_FAKE_TIME" 2>/dev/null || printf 0); n=$((n+1)); printf "%s" "$n" >"$LYX_FAKE_TIME"; printf "%s\\n" "$((n * ${LYX_FAKE_TIME_STEP:-1}))"\n',
  );
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("LYX_") && key !== "SSH_ORIGINAL_COMMAND",
      ),
    ),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    LYX_NODE_HOME: home,
    LYX_NODE_PREFIX: "lyxrelease",
    LYX_NODE_PROJECT: "lyxrelease",
    LYX_NODE_SUPERVISOR: "compose",
    LYX_IMAGE_PREFIX: "",
    LYX_FAKE_ASSETS: assets,
    LYX_FAKE_CALLS: join(dir, "calls"),
    LYX_FAKE_COUNT: join(dir, "count"),
    LYX_FAKE_TIME: join(dir, "time"),
    LYX_FAKE_HELPER: join(repoRoot, "infra/deploy/node-record.mjs"),
  };
  const run = (step: string, args: string[] = [], extra: Record<string, string> = {}) => {
    const result = spawnSync("bash", [join(repoRoot, "infra/deploy/node-step.sh"), step, ...args], {
      encoding: "utf8",
      env: { ...env, ...extra },
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    return {
      ...result,
      calls: existsSync(env.LYX_FAKE_CALLS)
        ? readFileSync(env.LYX_FAKE_CALLS, "utf8").trim().split("\n")
        : [],
    };
  };
  return { dir, home, assets, env, run };
}

describe("真实 bash 节点发布步骤，Docker/systemd 替身", () => {
  it("首次 facts 无 release.env 成功；P1 未接为 unavailable，实际查询错误关闭", () => {
    const f = fixture();
    expect(f.run("facts").stdout).toBe("LYX_CURRENT=\n");
    writeFileSync(join(f.home, "releases.log"), JSON.stringify(record()));
    expect(f.run("facts").status).toBe(1);
    expect(f.run("preflight").stdout).toContain('"p1":"unavailable"');
    const checked = f.run("preflight", [], {
      LYX_P1_CHECK: "enabled",
      LYX_FAKE_P1_IDS: JSON.stringify([UUID]),
    });
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain(UUID);
    expect(
      f.run("preflight", [], { LYX_P1_CHECK: "enabled", LYX_FAKE_FAIL: "exec lyxrelease-postgres" })
        .status,
    ).toBe(1);
    expect(
      f.run("preflight", [], { LYX_P1_CHECK: "enabled", LYX_FAKE_P1_TABLE: "f" }).stdout,
    ).toContain('"p1":"unavailable"');
  });
  it("stage-assets 连续执行不覆盖旧资源；内容冲突与提取/清场失败明确失败", () => {
    const f = fixture();
    const target = join(f.home, "static/admin/assets");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "old-111.js"), "old");
    expect(f.run("stage-assets", [VERSION]).status).toBe(0);
    expect(f.run("stage-assets", [VERSION]).status).toBe(0);
    expect(readFileSync(join(target, "old-111.js"), "utf8")).toBe("old");
    expect(readFileSync(join(target, "new-222.js"), "utf8")).toBe("new");
    writeFileSync(join(f.assets, "admin/new-222.js"), "different");
    const conflict = f.run("stage-assets", [VERSION]);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("拒绝覆盖");
    expect(readFileSync(join(target, "new-222.js"), "utf8")).toBe("new");
    expect(
      fixture().run("stage-assets", [VERSION], { LYX_FAKE_FAIL: "cp lyxrelease-assets" }).status,
    ).not.toBe(0);
    expect(
      fixture().run("stage-assets", [VERSION], { LYX_FAKE_FAIL: "rm lyxrelease-assets" }).status,
    ).not.toBe(0);
  });
  it("worker 先 SIGTERM 等旧容器退出，mediatool 随换；旧容器未退/查询失败不启动新容器", () => {
    const f = fixture();
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${OLD}\n`);
    const result = f.run("worker-swap", [VERSION]);
    expect(result.status).toBe(0);
    const calls = result.calls;
    expect(calls.findIndex((line) => /stop --timeout 60 worker$/.test(line))).toBeLessThan(
      calls.findIndex((line) => /stop --timeout 60 mediatool$/.test(line)),
    );
    expect(calls.findIndex((line) => /stop --timeout 60 mediatool$/.test(line))).toBeLessThan(
      calls.findIndex((line) => /up -d --no-deps mediatool$/.test(line)),
    );
    expect(calls.findIndex((line) => /up -d --no-deps mediatool$/.test(line))).toBeLessThan(
      calls.findIndex((line) => /up -d --no-deps worker$/.test(line)),
    );
    expect(readFileSync(join(f.home, "release.env"), "utf8")).toContain(VERSION);
    for (const extra of [{ LYX_FAKE_STATE: "running" }, { LYX_FAKE_FAIL: "ps -a" }] as Array<
      Record<string, string>
    >) {
      const broken = fixture();
      writeFileSync(join(broken.home, "release.env"), `LYX_TAG=${OLD}\n`);
      const stopped = broken.run("worker-swap", [VERSION], extra);
      expect(stopped.status).toBe(1);
      expect(stopped.calls.some((line) => line.includes("up -d"))).toBe(false);
    }
  });
  it("systemd 也是先 stop 后 start；api-stop 只停 api/gateway，30 秒上限", () => {
    const f = fixture();
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${OLD}\n`);
    const result = f.run("worker-swap", [VERSION], { LYX_NODE_SUPERVISOR: "systemd" });
    expect(result.status).toBe(0);
    expect(result.calls.filter((line) => line.startsWith("systemctl"))).toEqual([
      "systemctl stop lyx-worker.service",
      "systemctl stop lyx-mediatool.service",
      "systemctl enable lyx-mediatool.service",
      "systemctl start lyx-mediatool.service",
      "systemctl enable lyx-worker.service",
      "systemctl start lyx-worker.service",
    ]);
    const stopped = f.run("api-stop");
    expect(stopped.status).toBe(0);
    expect(stopped.calls.filter((line) => /stop --timeout 30/.test(line))).toHaveLength(2);
  });
  it("api-start 必须 readyz 连续三次 200，间歇失败重新计数，真实时间超时失败", () => {
    const f = fixture();
    const result = f.run("api-start", [VERSION], { LYX_FAKE_READY: "flaps" });
    expect(result.status).toBe(0);
    expect(readFileSync(f.env.LYX_FAKE_COUNT, "utf8")).toBe("5");
    const broken = fixture();
    expect(
      broken.run("api-start", [VERSION], { LYX_FAKE_READY: "fail", LYX_FAKE_TIME_STEP: "50" })
        .status,
    ).toBe(1);
  });
  it("image-facts 与 smoke 核真实版本；缺本地镜像、查询错误、版本不符均拒绝", () => {
    const f = fixture();
    expect(f.run("image-facts", [VERSION]).status).toBe(0);
    expect(f.run("image-facts", [VERSION], { LYX_FAKE_MISSING: "1" }).status).toBe(1);
    expect(f.run("smoke", [VERSION]).status).toBe(0);
    expect(f.run("smoke", [VERSION], { LYX_FAKE_VERSION: OLD }).status).toBe(1);
  });
  it("record 在当前旧镜像里执行真实 Node 校验，仅挂固定记录文件；首次拒绝仍可用目标本地镜像", () => {
    const f = fixture();
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${OLD}\n`);
    const encoded = Buffer.from(JSON.stringify(record(VERSION))).toString("base64url");
    const result = f.run("record", [VERSION, encoded]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.home, "releases.log"), "utf8"))).toMatchObject({
      version: VERSION,
    });
    const run = result.calls.find((line) => line.startsWith("run --rm"))!;
    expect(run).toContain(`liyoxi/server:${OLD}`);
    expect(run).toContain("--network none --read-only");
    expect(run).toContain(`source=${f.home}/releases.log,target=/records/releases.log`);
    expect(run).not.toContain("/secrets");
    expect(run).not.toContain(`source=${f.home},`);
    expect(f.run("record", [VERSION, encoded]).status).toBe(1);
    const newNode = fixture();
    expect(newNode.run("record", [VERSION, encoded]).status).toBe(0);
    expect(newNode.run("record", [VERSION, encoded], { LYX_FAKE_MISSING: "1" }).status).toBe(1);
  });
  it.each([
    ["stage-assets", []],
    ["api-stop", [VERSION]],
    ["record", [VERSION, "$(id)"]],
    ["record", [VERSION, "a".repeat(21847)]],
    ["unknown", []],
  ])("新窄协议 %s 的坏参数在 Docker 前拒绝", (step, args) => {
    const f = fixture();
    const result = f.run(step, args);
    expect(result.status).toBe(2);
    expect(result.calls).toHaveLength(0);
  });
  it("SSH_ORIGINAL_COMMAND 拒绝新增步骤里的 shell 注入，合法只读步骤能执行", () => {
    const f = fixture();
    for (const command of ["stage-assets t1; id", "record t1 $(id)", "facts extra", "prune; id"]) {
      const result = spawnSync("bash", [join(repoRoot, "infra/deploy/node-step.sh")], {
        encoding: "utf8",
        env: { ...f.env, SSH_ORIGINAL_COMMAND: command },
      });
      expect(result.status).toBe(2);
    }
    const result = spawnSync("bash", [join(repoRoot, "infra/deploy/node-step.sh")], {
      encoding: "utf8",
      env: { ...f.env, SSH_ORIGINAL_COMMAND: "facts" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LYX_CURRENT=");
  });
  it("prune 留最近三版与回滚资源；只删记录过的本项目旧 tag，未登记/其他项目不清", () => {
    const f = fixture();
    const tags = [OLD, VERSION, "sha-333333333333", "sha-444444444444"];
    writeFileSync(join(f.home, "release.env"), `LYX_TAG=${tags[3]}\n`);
    writeFileSync(
      join(f.home, "releases.log"),
      tags
        .map((tag, i) => JSON.stringify({ ...record(tag), runId: String(i).repeat(32) }))
        .join("\n") + "\n",
    );
    const aged = new Date("2026-01-01T00:00:00Z");
    for (const app of ["admin", "portal"]) {
      const dir = join(f.home, `static/${app}/assets`);
      mkdirSync(dir, { recursive: true });
      for (const tag of tags) {
        mkdirSync(join(f.home, "static/.releases", tag), { recursive: true });
        writeFileSync(join(f.home, "static/.releases", tag, `${app}.list`), `./${tag}.js\n`);
        writeFileSync(join(dir, `${tag}.js`), "resource");
        utimesSync(join(dir, `${tag}.js`), aged, aged);
      }
      writeFileSync(join(dir, "recent.js"), "recent");
    }
    const images = tags.map((tag) => `liyoxi/server|${tag}|fake`).join("\n");
    // 每个 repository 都单独查询，另外两类没有旧镜像。
    const result = f.run("prune", [], { LYX_FAKE_IMAGES: images });
    expect(result.status).toBe(0);
    expect(result.calls).toContain(`image rm liyoxi/server:${OLD}`);
    expect(result.calls.filter((line) => line.startsWith("image rm"))).toHaveLength(1);
    expect(
      result.calls.some((line) => line.includes("image prune") || line.includes("system prune")),
    ).toBe(false);
    for (const app of ["admin", "portal"]) {
      const dir = join(f.home, `static/${app}/assets`);
      expect(existsSync(join(dir, `${OLD}.js`))).toBe(false);
      for (const tag of tags.slice(1)) expect(existsSync(join(dir, `${tag}.js`))).toBe(true);
      expect(existsSync(join(dir, "recent.js"))).toBe(true);
    }
    const wrong = f.run("prune", [], { LYX_FAKE_IMAGES: `other/server|${OLD}|fake` });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("其他项目");
  });
});

describe("发布记录的真实文件追加", () => {
  it("严格字段/类型/版本一致/字节上限；重复 runId 不改历史；坏历史不放行清理", () => {
    const path = join(temp(), "releases.log");
    const valid = record(VERSION);
    const encoded = Buffer.from(JSON.stringify(valid)).toString("base64url");
    recordMain(["append", VERSION, encoded], path);
    expect(() => recordMain(["append", VERSION, encoded], path)).toThrow();
    expect(() => recordMain(["append", OLD, encoded], path)).toThrow();
    for (const bad of [
      { ...valid, extra: true },
      { ...valid, version: 123 },
      { ...valid, reason: "x".repeat(2049) },
      { ...valid, startedAt: "2026-02-31T00:00:00.000Z" },
      { ...valid, overrideP1: [ALERT, P1] },
    ])
      expect(() => validateRecord(bad)).toThrow();
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(() => recordMain(["append", VERSION, "a".repeat(21847)], path)).toThrow();
    writeFileSync(path, "not json\n");
    expect(() => recordMain(["keep", VERSION], path)).toThrow();
    writeFileSync(path, JSON.stringify(valid));
    expect(() => recordMain(["append", VERSION, encoded], path)).toThrow("完整行尾");
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(valid));
  });
  it("保留集有当前版，最多最近三个成功且去重；失败版本不挤掉成功版本", () => {
    const failed: ReleaseRecord = {
      ...record("sha-999999999999"),
      result: "failure",
      failedStep: "seed",
    };
    expect(
      protectedVersions(
        [record(OLD), record(VERSION), failed, record(VERSION)],
        "sha-333333333333",
      ),
    ).toEqual(["sha-333333333333", VERSION, OLD]);
  });
});
