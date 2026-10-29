#!/usr/bin/env node
// 只读 stdin；不回显坏行。完整输入通过边界后才输出，避免把截断样本当完整统计。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  lineBytes: 16_384,
  rows: 100_000,
  matches: 200,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEALTH = new Set(["/health", "/healthz", "/readyz"]);
const fail = (message) => {
  throw new Error(`日志读取：${message}`);
};

function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const zone = match[2];
  const hours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const minutes = zone === "Z" ? 0 : Number(zone.slice(4));
  if (hours > 23 || minutes > 59) return null;
  const offset = (hours * 60 + minutes) * (zone.startsWith("-") ? -1 : 1);
  return new Date(epoch + offset * 60_000).toISOString().slice(0, 19) === match[1] ? epoch : null;
}

/** 导出只为本机用例；CLI 的分钟与请求编号仍逐项严格校验。 */
export async function readLogs(input, mode, value, now = Date.now(), options = {}) {
  if (!["stats", "logs"].includes(mode)) fail("只接受 stats 或 logs");
  const byEnvVersion = options.byEnvVersion === true;
  const clientVersion = options.clientVersion;
  if (
    Object.keys(options).some((key) => !["byEnvVersion", "clientVersion"].includes(key)) ||
    (options.byEnvVersion !== undefined && typeof options.byEnvVersion !== "boolean") ||
    ((byEnvVersion || clientVersion !== undefined) && mode !== "stats") ||
    (clientVersion !== undefined && (!byEnvVersion || !/^sha-[a-f0-9]{12}$/.test(clientVersion)))
  )
    fail("版本分组只接受stats与可选sha-12客户端版本");
  const envVersions = { develop: 0, trial: 0, release: 0, unknown: 0 };
  let otherClientVersions = 0;
  if (mode === "stats" && !/^(?:[1-9]\d{0,2}|1[0-3]\d\d|14[0-3]\d|1440)$/.test(value))
    fail("分钟必须是 1–1440 的整数");
  if (mode === "logs" && !UUID.test(value)) fail("请求编号必须是 UUID");
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) fail("统计时刻不合法");
  const start = now - Number(mode === "stats" ? value : 60) * 60_000;
  const samples = [];
  const matching = [];
  let bytes = 0,
    rows = 0,
    badLines = 0,
    excluded = 0,
    outsideWindow = 0,
    errors = 0;
  let pending = Buffer.alloc(0);
  const rowLimit = mode === "stats" ? LIMITS.rows : 5000;
  function line(buffer) {
    if (++rows > rowLimit) fail("输入行数超限，拒绝输出截断结果");
    if (buffer.length > LIMITS.lineBytes) fail("单行字节超限");
    let row;
    try {
      row = JSON.parse(buffer.toString("utf8"));
    } catch {
      badLines++;
      return;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      badLines++;
      return;
    }
    if (mode === "logs") {
      if (
        [row.reqId, row.request_id].some(
          (id) => typeof id === "string" && id.toLowerCase() === value.toLowerCase(),
        )
      ) {
        if (matching.length === LIMITS.matches) fail("匹配行数超限，拒绝输出截断结果");
        matching.push(buffer.toString("utf8"));
      }
      return;
    }
    const time = timestamp(row.time);
    if (
      time === null ||
      !Number.isInteger(row.status) ||
      row.status < 100 ||
      row.status > 599 ||
      typeof row.request_time !== "number" ||
      !Number.isFinite(row.request_time) ||
      row.request_time < 0 ||
      typeof row.path !== "string" ||
      !row.path.startsWith("/")
    ) {
      badLines++;
      return;
    }
    if (time < start || time > now) {
      outsideWindow++;
      return;
    }
    if (HEALTH.has(row.path)) {
      excluded++;
      return;
    }
    if (byEnvVersion) {
      if (clientVersion !== undefined && row.client_version !== clientVersion) {
        otherClientVersions++;
        return;
      }
      const env =
        typeof row.env_version === "string" &&
        ["develop", "trial", "release"].includes(row.env_version)
          ? row.env_version
          : "unknown";
      envVersions[env]++;
    }
    samples.push(row.request_time);
    if (row.status >= 500) errors++;
  }
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > LIMITS.bytes) fail("输入总字节超限");
    let offset = 0,
      end;
    while ((end = buffer.indexOf(10, offset)) !== -1) {
      const part = buffer.subarray(offset, end);
      line(pending.length ? Buffer.concat([pending, part]) : part);
      pending = Buffer.alloc(0);
      offset = end + 1;
    }
    const remainder = buffer.subarray(offset);
    if (pending.length + remainder.length > LIMITS.lineBytes) fail("单行字节超限");
    pending = Buffer.concat([pending, remainder]);
  }
  if (pending.length) line(pending);
  if (mode === "logs") return matching.join("\n") + (matching.length ? "\n" : "");
  samples.sort((a, b) => a - b);
  return (
    JSON.stringify({
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(now).toISOString(),
      minutes: Number(value),
      samples: samples.length,
      errors5xx: errors,
      rate5xx: samples.length ? errors / samples.length : null,
      p95Seconds: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
      excluded,
      badLines,
      outsideWindow,
      inputRows: rows,
      ...(byEnvVersion
        ? { clientVersion: clientVersion ?? null, envVersions, otherClientVersions }
        : {}),
    }) + "\n"
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, value, ...extra] = process.argv.slice(2);
  try {
    const grouped =
      extra[0] === "--by-env-version" &&
      (extra.length === 1 || (extra.length === 3 && extra[1] === "--client-version"));
    if (!value || (extra.length && !grouped))
      fail(
        "用法：log-stats.mjs stats <分钟> [--by-env-version [--client-version sha-12]] | logs <UUID>",
      );
    process.stdout.write(
      await readLogs(
        process.stdin,
        mode,
        value,
        Date.now(),
        grouped ? { byEnvVersion: true, ...(extra[2] ? { clientVersion: extra[2] } : {}) } : {},
      ),
    );
  } catch (error) {
    // 只输出自己的固定错误；底层流错误不泄漏日志或运行环境。
    process.stderr.write(
      `${error instanceof Error && error.message.startsWith("日志读取：") ? error.message : "日志读取：输入流失败"}\n`,
    );
    process.exitCode = 1;
  }
}
