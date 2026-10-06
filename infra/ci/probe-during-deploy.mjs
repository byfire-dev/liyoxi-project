#!/usr/bin/env node
// 每秒发起一轮；独立进程运行，节点步骤的同步等待不会阻塞探测。
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function validateTargets(value) {
  if (!Array.isArray(value) || !value.length || value.length > 4096)
    throw new Error("探测目标须为 1–4096 项");
  const names = new Set();
  return value.map((target) => {
    if (
      !target ||
      typeof target !== "object" ||
      Object.keys(target).some(
        (key) => !["name", "url", "host", "sha256", "contains"].includes(key),
      ) ||
      typeof target.name !== "string" ||
      typeof target.url !== "string" ||
      !/^[a-zA-Z0-9/_.-]{1,512}$/.test(target.name ?? "") ||
      names.has(target.name)
    )
      throw new Error("探测目标名称或字段不合法");
    const url = new URL(target.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error("探测 URL 不合法");
    if (target.host !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]{1,5})?$/.test(target.host))
      throw new Error("探测 Host 不合法");
    if (target.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(target.sha256))
      throw new Error("探测摘要不合法");
    if (
      target.contains !== undefined &&
      (typeof target.contains !== "string" ||
        !target.contains.length ||
        target.contains.length > 512)
    )
      throw new Error("探测内容断言不合法");
    names.add(target.name);
    return { ...target, url: url.href };
  });
}

export async function requestTarget(target, timeoutMs = 900) {
  return new Promise((done) => {
    const url = new URL(target.url);
    const client = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(error);
    };
    const req = client.request(
      url,
      { headers: target.host ? { Host: target.host } : {} },
      (res) => {
        if (res.statusCode !== 200) {
          finish(`HTTP ${res.statusCode}`);
          res.destroy();
          return;
        }
        const digest = createHash("sha256");
        const decoder = new StringDecoder("utf8");
        let bytes = 0,
          tail = "",
          found = !target.contains;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) {
            finish("响应超过 32 MiB");
            req.destroy();
            return;
          }
          digest.update(chunk);
          if (target.contains && !found) {
            tail += decoder.write(chunk);
            found = tail.includes(target.contains);
            tail = tail.slice(-512);
          }
        });
        res.on("end", () => {
          if (target.sha256 && digest.digest("hex") !== target.sha256) finish("sha256 不符");
          else if (!found && !(tail + decoder.end()).includes(target.contains)) finish("内容不符");
          else finish(null);
        });
        res.on("error", (error) => finish(error.message));
      },
    );
    const timer = setTimeout(() => {
      finish("请求超时");
      req.destroy();
    }, timeoutMs);
    req.on("error", (error) => finish(error.message));
    req.end();
  });
}

export async function checkTargets(targets) {
  const validated = validateTargets(targets);
  const errors = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, validated.length) }, async () => {
      while (next < validated.length) {
        const target = validated[next++];
        const error = await requestTarget(target, 5000);
        if (error) errors.push({ name: target.name, error });
      }
    }),
  );
  return errors;
}

function save(path, report) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export async function probe({ targets, output, signal, durationMs, onReady }) {
  targets = validateTargets(targets);
  if (targets.length > 32) throw new Error("每秒探测至多 32 项；全资源用独立完整核对");
  const start = Date.now();
  const report = {
    schemaVersion: 1,
    startedAt: new Date(start).toISOString(),
    finishedAt: null,
    intervalMs: 1000,
    rounds: 0,
    requests: 0,
    failures: 0,
    durationMs: 0,
    targets: targets.map(({ name, url, host }) => ({
      name,
      url,
      ...(host ? { host } : {}),
      requests: 0,
      failures: 0,
      interruptionMs: 0,
      outages: [],
    })),
  };
  const opened = new Map();
  const sample = async () => {
    const sampledAt = Date.now();
    report.rounds++;
    await Promise.all(
      targets.map(async (target, index) => {
        const error = await requestTarget(target);
        const row = report.targets[index];
        row.requests++;
        report.requests++;
        if (error) {
          row.failures++;
          report.failures++;
          if (!opened.has(index))
            opened.set(index, {
              startedAt: new Date(sampledAt).toISOString(),
              error,
              start: sampledAt,
            });
        } else if (opened.has(index)) {
          const open = opened.get(index);
          const durationMs = sampledAt - open.start;
          row.outages.push({
            startedAt: open.startedAt,
            finishedAt: new Date(sampledAt).toISOString(),
            durationMs,
            ongoing: false,
            error: open.error,
          });
          row.interruptionMs += durationMs;
          opened.delete(index);
        }
      }),
    );
  };
  while (!signal?.aborted && (durationMs === undefined || Date.now() - start < durationMs)) {
    await sample();
    if (!report.rounds) throw new Error("未形成探测样本");
    if (output) save(output, report);
    if (report.rounds === 1) onReady?.();
    const wait = Math.max(0, start + report.rounds * 1000 - Date.now());
    if (signal?.aborted) break;
    await new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, wait);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
  const end = Date.now();
  for (const [index, open] of opened) {
    const durationMs = end - open.start;
    report.targets[index].outages.push({
      startedAt: open.startedAt,
      finishedAt: new Date(end).toISOString(),
      durationMs,
      ongoing: true,
      error: open.error,
    });
    report.targets[index].interruptionMs += durationMs;
  }
  report.finishedAt = new Date(end).toISOString();
  report.durationMs = end - start;
  if (output) save(output, report);
  return report;
}

export async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      output: { type: "string" },
      duration: { type: "string" },
    },
  });
  if (!values.config || !values.output) throw new Error("须给 --config 与 --output");
  const durationMs = values.duration === undefined ? undefined : Number(values.duration) * 1000;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0))
    throw new Error("--duration 须为正秒数");
  const targets = validateTargets(JSON.parse(readFileSync(values.config, "utf8")));
  if (targets.length > 32) throw new Error("每秒探测至多 32 项");
  const controller = new AbortController();
  const stop = () => controller.abort();
  const parent = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== parent) stop();
  }, 1000);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await probe({
      targets,
      output: values.output,
      signal: controller.signal,
      durationMs,
      onReady: () => console.log("LYX_PROBE_READY"),
    });
  } finally {
    clearInterval(parentWatch);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
