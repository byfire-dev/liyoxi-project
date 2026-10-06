#!/usr/bin/env node
// 节点上不要求装 Node：由固定 server 镜像执行，源只读挂载，只有记录目录可写。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD_LIMIT = 16_384;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STEPS = new Set([
  "precheck",
  "facts",
  "preflight",
  "image-facts",
  "pull",
  "check-env",
  "stage-assets",
  "migrate",
  "seed",
  "worker-swap",
  "api-stop",
  "api-start",
  "status",
  "verify-db",
  "smoke",
  "prune",
]);

function fail(message) {
  throw new Error(`发布记录：${message}`);
}
function exactKeys(object, keys) {
  if (
    !object ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    Object.keys(object).sort().join("|") !== [...keys].sort().join("|")
  )
    fail("字段不符");
}
function text(value, max) {
  return typeof value === "string" && value.length <= max;
}
function duration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 31 * 86400_000;
}
function tag(value) {
  return typeof value === "string" && TAG.test(value);
}

export function validateRecord(record) {
  exactKeys(record, [
    "schemaVersion",
    "runId",
    "action",
    "version",
    "previousVersion",
    "startedAt",
    "finishedAt",
    "durationMs",
    "result",
    "failedStep",
    "onlineTouched",
    "runtimeTouched",
    "rollbackSafe",
    "reason",
    "overrideP1",
    "p1",
    "compatibility",
    "imageDigests",
    "steps",
  ]);
  if (
    record.schemaVersion !== 1 ||
    typeof record.runId !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.runId) ||
    !["release", "rollback"].includes(record.action) ||
    !tag(record.version) ||
    !(record.previousVersion === null || tag(record.previousVersion)) ||
    !["success", "failure"].includes(record.result) ||
    !duration(record.durationMs) ||
    ![record.startedAt, record.finishedAt].every(
      (value) =>
        typeof value === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value,
    ) ||
    Date.parse(record.finishedAt) < Date.parse(record.startedAt) ||
    !(record.failedStep === null || STEPS.has(record.failedStep)) ||
    ![record.onlineTouched, record.runtimeTouched, record.rollbackSafe].every(
      (value) => typeof value === "boolean",
    ) ||
    !text(record.reason, 2048) ||
    !Array.isArray(record.overrideP1) ||
    record.overrideP1.length > 100 ||
    !record.overrideP1.every((value) => typeof value === "string" && UUID.test(value)) ||
    !["unavailable", "clear", "overridden", "blocked"].includes(record.p1) ||
    !["unavailable", "passed", "failed"].includes(record.compatibility)
  )
    fail("值不符");
  exactKeys(record.imageDigests, ["server", "gateway", "mediatool"]);
  if (
    !Object.values(record.imageDigests).every(
      (value) => value === null || (typeof value === "string" && SHA.test(value)),
    )
  )
    fail("镜像摘要不符");
  if (!Array.isArray(record.steps) || record.steps.length > 32) fail("步骤不符");
  for (const step of record.steps) {
    exactKeys(step, ["name", "durationMs", "exitCode"]);
    if (
      !STEPS.has(step.name) ||
      !duration(step.durationMs) ||
      !Number.isInteger(step.exitCode) ||
      step.exitCode < 0 ||
      step.exitCode > 255
    )
      fail("步骤值不符");
  }
  if (
    record.result === "success" &&
    (record.failedStep !== null ||
      record.steps.some((step) => step.exitCode !== 0) ||
      Object.values(record.imageDigests).some((value) => value === null))
  )
    fail("成功记录不完整");
  if (record.result === "failure" && record.failedStep === null) fail("失败记录缺少步骤");
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > RECORD_LIMIT) fail("超过字节上限");
  return record;
}

export function readRecords(path) {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, "utf8");
  if (contents && !contents.endsWith("\n")) fail("历史记录缺少完整行尾，拒绝追加或清理");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (Buffer.byteLength(line) > RECORD_LIMIT) fail("历史行超过字节上限");
      return validateRecord(JSON.parse(line));
    });
}

export function protectedVersions(records, current) {
  if (!TAG.test(current)) fail("当前标签不符");
  const keep = [current];
  for (const record of [...records].reverse()) {
    if (record.result === "success" && !keep.includes(record.version)) keep.push(record.version);
    if (keep.length === 3) break;
  }
  return keep;
}

export function main(args, path = "/records/releases.log") {
  const [mode, tag, encoded] = args;
  if (!TAG.test(tag ?? "")) fail("标签不符");
  if (mode === "keep" && args.length === 2) {
    console.log(protectedVersions(readRecords(path), tag).join("\n"));
    return;
  }
  if (mode === "known" && args.length === 2) {
    console.log(
      [
        ...new Set(
          readRecords(path)
            .filter((row) => row.result === "success")
            .map((row) => row.version),
        ),
      ].join("\n"),
    );
    return;
  }
  if (mode !== "append" || args.length !== 3 || !/^[A-Za-z0-9_-]{1,21846}$/.test(encoded ?? ""))
    fail("参数不符");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > RECORD_LIMIT || bytes.toString("base64url") !== encoded)
    fail("编码或长度不符");
  const record = validateRecord(JSON.parse(bytes.toString("utf8")));
  // tag 是被记录的目标版本，执行 helper 的 runner 镜像可以是旧版。
  if (record.version !== tag) fail("标签与记录版本不一致");
  const old = readRecords(path);
  if (old.some((row) => row.runId === record.runId)) fail("同一运行已记录，拒绝改写");
  appendFileSync(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flush: true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "发布记录失败");
    process.exitCode = 1;
  }
}
