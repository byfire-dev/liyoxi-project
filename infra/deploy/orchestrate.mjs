#!/usr/bin/env node
// 单机预发：只调登记的节点步骤，不构建镜像、不读取密钥、不启动工作流。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { validateRecord } from "./node-record.mjs";

const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = /^sha256:[a-f0-9]{64}$/;
export const RELEASE_STEPS = [
  "pull",
  "check-env",
  "stage-assets",
  "verify-assets",
  "migrate",
  "seed",
  "worker-swap",
  "api-stop",
  "api-start",
  "status",
  "verify-db",
  "smoke",
  "verify-assets-live",
  "prune",
];
export const ROLLBACK_STEPS = [
  "verify-assets",
  "api-stop",
  "api-start",
  "worker-swap",
  "status",
  "verify-db",
  "smoke",
  "verify-assets-live",
];
const UNTAGGED = new Set(["api-stop", "status", "prune", "preflight", "facts"]);

export function createChannel({
  local = false,
  node,
  script = join(ROOT, "infra/deploy/node-step.sh"),
}) {
  if (!local && !/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(node ?? ""))
    throw new Error("SSH 节点须是 <发布用户>@<主机>，不带选项");
  return (step, args = []) => {
    // 参数仅标签或 base64url；SSH 的强制命令也再次校验，不发任意 shell。
    if (!/^[a-z-]+$/.test(step) || args.some((arg) => !/^[A-Za-z0-9_.-]+$/.test(arg)))
      throw new Error("通道参数不合法");
    const result = spawnSync(
      local ? "bash" : "ssh",
      local
        ? [script, step, ...args]
        : [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=15",
            "--",
            node,
            step,
            ...args,
          ],
      { encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.error ? `${result.error.message}\n` : (result.stderr ?? ""),
    };
  };
}

function marked(stdout, prefix) {
  const lines = stdout.split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error(`节点结果缺少唯一 ${prefix}`);
  return lines[0].slice(prefix.length);
}

export function parseFacts(stdout) {
  const current = marked(stdout, "LYX_CURRENT=");
  if (current && !TAG.test(current)) throw new Error("节点当前标签不合法");
  const records = stdout
    .split("\n")
    .filter((line) => line.startsWith("LYX_RECORD="))
    .map((line) => validateRecord(JSON.parse(line.slice("LYX_RECORD=".length))));
  return { current: current || null, records };
}

export function rollbackTarget(facts, requested, force = false, reason = "") {
  const success = [...facts.records].reverse().filter((record) => record.result === "success");
  const target = requested ?? success.find((record) => record.version !== facts.current)?.version;
  if (!target || !TAG.test(target)) throw new Error("没有上一个成功版本，须指定本地已有的回滚标签");
  // 目标之后任何已触碰线上的不安全记录都须越过；包含失败/半成品发布，不能只看最后一条成功。
  let targetIndex = -1;
  facts.records.forEach((record, index) => {
    if (record.version === target && record.result === "success") targetIndex = index;
  });
  const currentRecords = facts.records.slice(targetIndex + 1);
  if (
    currentRecords.some((record) => !record.rollbackSafe && record.onlineTouched) &&
    !(force && reason.trim())
  )
    throw new Error("当前版本标为回滚不安全，须 --force 并给非空 --reason");
  return target;
}

export function orchestrate(
  options,
  channel,
  { clock = () => Date.now(), runId = randomBytes(16).toString("hex") } = {},
) {
  const started = clock();
  const record = {
    schemaVersion: 1,
    runId,
    action: options.rollback ? "rollback" : "release",
    version: options.tag ?? "unknown",
    previousVersion: null,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started).toISOString(),
    durationMs: 0,
    result: "failure",
    failedStep: "precheck",
    onlineTouched: false,
    runtimeTouched: false,
    rollbackSafe: options.rollbackSafe !== false,
    reason: options.reason ?? "",
    overrideP1: options.overrideP1 ?? [],
    p1: "unavailable",
    compatibility: options.compatibility ?? "unavailable",
    imageDigests: { server: null, gateway: null, mediatool: null },
    steps: [],
  };
  let error = "";
  let recordError = "";
  const call = (step, args = []) => {
    record.failedStep = step;
    const before = clock();
    const result = channel(step, args);
    const exitCode = result.status === 0 ? 0 : Math.max(1, Math.min(255, result.status ?? 1));
    record.steps.push({ name: step, durationMs: Math.max(0, clock() - before), exitCode });
    if (exitCode)
      throw new Error(
        `停在 ${step}（退出码 ${exitCode}）${result.stderr ? `：${result.stderr.trim()}` : ""}`,
      );
    return result.stdout;
  };
  try {
    validateRecord(record);
    if (options.freeze === true) throw new Error("STG_FREEZE=true，停在预检");
    if (record.compatibility === "failed") throw new Error("混跑兼容检查失败，停在预检");
    if (!options.rollback && !TAG.test(options.tag ?? "")) throw new Error("发布须给合法 --tag");
    if (!record.reason.trim() && (options.force || record.overrideP1.length))
      throw new Error("越过拒绝条件须给非空 --reason");
    const facts = parseFacts(call("facts"));
    record.previousVersion = facts.current;
    if (options.rollback)
      record.version = rollbackTarget(facts, options.tag, options.force, record.reason);
    const preflight = JSON.parse(marked(call("preflight"), "LYX_PREFLIGHT="));
    if (
      !preflight ||
      Object.keys(preflight).sort().join("|") !== "ids|p1" ||
      !["unavailable", "checked"].includes(preflight.p1) ||
      !Array.isArray(preflight.ids) ||
      preflight.ids.length > 100 ||
      !preflight.ids.every(
        (id) =>
          typeof id === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id),
      ) ||
      (preflight.p1 === "unavailable" && preflight.ids.length)
    )
      throw new Error("P1 预检返回值不合法");
    if (preflight.p1 === "checked") {
      record.p1 = preflight.ids.length ? "blocked" : "clear";
      if (preflight.ids.some((id) => !record.overrideP1.includes(id)))
        throw new Error("有未恢复的 P1，停在预检");
      if (preflight.ids.length) record.p1 = "overridden";
    }
    const imageFacts = () => {
      const output = call("image-facts", [record.version]);
      for (const name of ["server", "gateway", "mediatool"]) {
        const value = marked(output, `LYX_IMAGE=${name}|`);
        if (!SHA.test(value)) throw new Error("本地目标镜像摘要不合法");
        record.imageDigests[name] = value;
      }
    };
    if (options.rollback) imageFacts(); // 缺镜像在任何 stop 之前拒绝，不从仓库临时拉。
    for (const step of options.rollback ? ROLLBACK_STEPS : RELEASE_STEPS) {
      if (step === "migrate") record.onlineTouched = true; // 迁移失败也可能已经做过一部分。
      if (["worker-swap", "api-stop", "api-start"].includes(step)) {
        record.onlineTouched = true;
        record.runtimeTouched = true;
      }
      call(
        step,
        UNTAGGED.has(step)
          ? []
          : step === "verify-assets-live" && record.previousVersion
            ? [record.version, record.previousVersion]
            : [record.version],
      );
      if (step === "pull") imageFacts();
    }
    record.result = "success";
    record.failedStep = null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "发布失败";
  }
  const finished = clock();
  record.finishedAt = new Date(finished).toISOString();
  record.durationMs = Math.max(0, finished - started);
  // 发布前拒绝且未知回滚标签时无法在节点写目标记录；CI 摘要仍完整。
  try {
    if (TAG.test(record.version)) {
      validateRecord(record);
      const encoded = Buffer.from(JSON.stringify(record)).toString("base64url");
      const saved = channel("record", [record.version, encoded]);
      if (saved.status !== 0) recordError = saved.stderr?.trim() || "节点发布记录未写成";
    } else recordError = "没有目标版本，未追加节点记录";
  } catch (caught) {
    recordError = caught instanceof Error ? caught.message : "节点发布记录未写成";
  }
  return {
    ...record,
    error,
    recordError,
    exitCode: record.result === "success" && !recordError ? 0 : 1,
  };
}

async function startProbe(config, output, env) {
  const child = spawn(
    process.execPath,
    [join(ROOT, "infra/ci/probe-during-deploy.mjs"), "--config", config, "--output", output],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let detail = "";
  child.stderr.on("data", (chunk) => {
    detail = (detail + chunk).slice(-8192);
  });
  const ended = new Promise((done) => {
    child.once("error", (error) => done({ code: 2, error: error.message }));
    child.once("exit", (code) => done({ code, error: detail }));
  });
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("持续探测启动超时"));
    }, 5000);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-8192);
      if (stdout.includes("LYX_PROBE_READY\n")) {
        clearTimeout(timeout);
        done();
      }
    });
    ended.then((result) => {
      clearTimeout(timeout);
      reject(new Error(`持续探测未启动：${result.error}`));
    });
  });
  return {
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      const result = await ended;
      clearTimeout(timeout);
      if (result.code !== 0) throw new Error(`持续探测异常：${result.error}`);
      const report = JSON.parse(readFileSync(output, "utf8"));
      if (report.schemaVersion !== 1 || !report.finishedAt || report.rounds < 1)
        throw new Error("持续探测缺少完整记录");
      return report;
    },
  };
}

export async function main(args, env = process.env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      tag: { type: "string" },
      rollback: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      reason: { type: "string" },
      "override-p1": { type: "string", multiple: true },
      "rollback-safe": { type: "string", default: "true" },
      "compat-result": { type: "string", default: "unavailable" },
      local: { type: "boolean", default: false },
      node: { type: "string" },
      summary: { type: "string" },
      "probe-config": { type: "string" },
      "probe-summary": { type: "string" },
    },
  });
  if (values.local && values.node) throw new Error("--local 与 --node 只能选一个");
  if (
    !["true", "false"].includes(values["rollback-safe"]) ||
    !["passed", "failed", "unavailable"].includes(values["compat-result"])
  )
    throw new Error("发布标记不合法");
  if (Boolean(values["probe-config"]) !== Boolean(values["probe-summary"]))
    throw new Error("持续探测须同时给 --probe-config 与 --probe-summary");
  const monitor = values["probe-config"]
    ? await startProbe(values["probe-config"], values["probe-summary"], env)
    : null;
  let result;
  let probeReport = null;
  let probeError = "";
  try {
    result = orchestrate(
      {
        tag: values.tag,
        rollback: values.rollback,
        force: values.force,
        reason: values.reason,
        overrideP1: values["override-p1"],
        rollbackSafe: values["rollback-safe"] === "true",
        compatibility: values["compat-result"],
        freeze: env.STG_FREEZE === "true",
      },
      createChannel({ local: values.local, node: values.node }),
    );
  } finally {
    if (monitor) {
      try {
        probeReport = await monitor.stop();
      } catch (error) {
        probeError = error instanceof Error ? error.message : "持续探测没保存";
      }
    }
  }
  result = {
    ...result,
    probe: probeReport,
    probeError,
    probeStatus: monitor ? "recorded" : "unconfigured",
  };
  if (probeError) {
    result.probeStatus = "failed";
    result.exitCode = 1;
  }
  const json = JSON.stringify(result, null, 2);
  if (values.summary) writeFileSync(values.summary, `${json}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### ${result.action} ${result.version}\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    );
  console.log(json);
  return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "编排失败");
    process.exitCode = 2;
  }
}
