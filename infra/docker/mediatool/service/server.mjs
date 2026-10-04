// @ts-check
// 狸有戏 · mediatool 容器内服务（D5 第 6.6 节）。只用 Node 内置模块，没有构建步骤。
//
// 在 /work/.sock/mediatool.sock 上听 HTTP + JSON：
//   POST /probe      { path, demuxers, timeoutMs? }                → { ok, report }
//   POST /poster     { path, demuxer, atMs, outPath, timeoutMs? }  → { ok, sizeBytes, atMs }
//   POST /stampAigc  { path, outPath, aigcJson, timeoutMs? }       → { ok, report, inputSizeBytes, outputSizeBytes }
//   GET  /healthz    版本、上限、排队情况、容器里别的进程
//   GET  /selfcheck  容器自查（见 selfcheck.mjs）
// 没办成：{ ok: false, error: { code, message } }，HTTP 状态码 4xx / 5xx。
// 路径只认共享目录 /work 下的相对路径；本服务不取任何远端内容。同时最多跑两个操作，其余排队。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import { dirname } from "node:path";

import { LIMITS, poster, probe, stampAigc } from "./ops.mjs";
import { RequestError, SOCKET_PATH } from "./paths.mjs";
import { children, killGroup } from "./run.mjs";
import { selfcheck } from "./selfcheck.mjs";

const CONCURRENCY = 2;
const MAX_QUEUE = 32;
const MAX_BODY_BYTES = 64 * 1024;

/** @type {Record<string, (body: any) => Promise<object>>} */
const OPS = { "/probe": probe, "/poster": poster, "/stampAigc": stampAigc };

/** 取 “ffmpeg version 5.1.9-0+deb12u1 …” 里的版本号 @param {string} bin */
function versionOf(bin) {
  const first = execFileSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" });
  return first.split("\n")[0]?.split(" ")[2] ?? "";
}
const versions = { ffmpeg: versionOf("ffmpeg"), ffprobe: versionOf("ffprobe") };

const stats = { running: 0, queued: 0, peakRunning: 0, completed: 0, failed: 0 };
/** @type {(() => void)[]} */
const waiting = [];

/** 占一个并发名额；满了就排队，排队也满了就拒绝 */
function acquire() {
  if (stats.running < CONCURRENCY) {
    stats.running += 1;
    stats.peakRunning = Math.max(stats.peakRunning, stats.running);
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) throw new RequestError("busy", "排队已满，稍后再试", 503);
  stats.queued = waiting.length + 1;
  return new Promise((/** @type {(value?: undefined) => void} */ resolve) => waiting.push(resolve));
}

/** 名额直接交给排在最前面的，没有人排队才释放 */
function release() {
  const next = waiting.shift();
  stats.queued = waiting.length;
  if (next) next();
  else stats.running -= 1;
}

/**
 * 读请求体。超过上限的部分只读不存，读完再拒绝：中途掐断连接的话调用端收不到应答。
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    req.on("data", (/** @type {Buffer} */ chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (bytes > MAX_BODY_BYTES) {
        reject(new RequestError("too_large", "请求体超过 64KB", 413));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body !== null && typeof body === "object" && !Array.isArray(body)) {
          resolve(body);
          return;
        }
      } catch {
        // 落到下面
      }
      reject(new RequestError("bad_request", "请求体要是一个 JSON 对象"));
    });
  });
}

/** 容器里除本服务以外的进程：硬超时之后这里不该还有 ffmpeg / ffprobe */
async function otherProcesses() {
  const procs = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const comm = await readFile(`/proc/${entry}/comm`, "utf8").catch(() => null);
    if (comm !== null) procs.push({ pid: Number(entry), comm: comm.trim() });
  }
  return procs;
}

/** @param {http.IncomingMessage} req */
async function handle(req) {
  if (req.method === "GET" && req.url === "/healthz") {
    const limits = { ...LIMITS, concurrency: CONCURRENCY, maxQueue: MAX_QUEUE };
    return { service: "mediatool", ...versions, limits, stats, procs: await otherProcesses() };
  }
  if (req.method === "GET" && req.url === "/selfcheck") return { sandbox: await selfcheck() };
  const op = req.method === "POST" && req.url ? OPS[req.url] : undefined;
  if (!op) throw new RequestError("unknown_op", "没有这个操作", 404);
  const body = await readBody(req);
  await acquire();
  try {
    return await op(body);
  } finally {
    release();
  }
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  /** @param {number} status @param {object} payload */
  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
    // 一次调用一行日志。容器里没有任何密钥，路径都在 /work 下
    const line = { at: new Date().toISOString(), op: req.url, status, ms: Date.now() - started };
    if (req.url !== "/healthz") console.log(JSON.stringify(line));
  };
  handle(req).then(
    (result) => {
      stats.completed += 1;
      send(200, { ok: true, ...result });
    },
    (err) => {
      stats.failed += 1;
      if (err instanceof RequestError) {
        send(err.status, { ok: false, error: { code: err.code, message: err.message } });
      } else {
        console.error(err);
        send(500, { ok: false, error: { code: "internal", message: "内部错误" } });
      }
    },
  );
});

// 产物与套接字不给“其他人”权限（套接字的权限在建它的时候由 umask 定）：共享目录由同一个用户（或同组）的调用端读写
process.umask(0o007);
mkdirSync(dirname(SOCKET_PATH), { recursive: true });
rmSync(SOCKET_PATH, { force: true });
server.listen(SOCKET_PATH, () => {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), listening: SOCKET_PATH, ...versions }),
  );
});

// 本进程是容器的 1 号进程：不自己处理信号就停不下来
for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
  process.on(signal, () => {
    for (const child of children) killGroup(child);
    rmSync(SOCKET_PATH, { force: true });
    process.exit(0);
  });
}
