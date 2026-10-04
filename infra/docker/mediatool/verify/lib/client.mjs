// @ts-check
// 验证用例用的最小调用端：经共享目录里的 Unix 套接字发 HTTP + JSON。只用 Node 内置模块。
// 正式的调用端（带输出校验）在 packages/services/src/providers/mediatool/。
import { readFileSync, statSync, utimesSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { ARMED, FX, WORK } from "./spec.mjs";

export const SOCKET = join(WORK, ".sock", "mediatool.sock");

/**
 * @param {"GET" | "POST"} method
 * @param {string} path
 * @param {unknown} [body] 对象会转成 JSON；字符串原样发（造坏请求用）
 * @returns {Promise<{ status: number, json: any, ms: number }>}
 */
export function call(method, path, body) {
  const started = Date.now();
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: SOCKET,
        method,
        path,
        timeout: 150_000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // 不是 JSON：留 null，由用例断言
          }
          resolve({ status: res.statusCode ?? 0, json, ms: Date.now() - started });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("调用超时")));
    request.on("error", reject);
    request.end(payload);
  });
}

export const probe = (/** @type {string} */ file, /** @type {object} */ extra = {}) =>
  call("POST", "/probe", { path: `${FX}/${file}`, demuxers: ["mov"], ...extra });
export const healthz = () => call("GET", "/healthz");

/** 共享目录下测试片的绝对路径 @param {string} file */
export const fx = (file) => join(WORK, FX, file);
/** 造片脚本留下的清单：文件大小与对照结果 */
export const manifest = () => JSON.parse(readFileSync(fx("manifest.json"), "utf8"));

/** 把访问时间拨回 ARMED：之后还是 ARMED 就说明没有人读过这个文件 @param {string} path */
export const arm = (path) => utimesSync(path, ARMED, statSync(path).mtime);
/** @param {string} path */
export const wasRead = (path) => statSync(path).atime.getTime() !== ARMED.getTime();

/** 第一条视频流、全部音频流 @param {any} report */
export const videoOf = (report) =>
  report.streams.find((/** @type {any} */ s) => s.codecType === "video");
/** @param {any} report */
export const audiosOf = (report) =>
  report.streams.filter((/** @type {any} */ s) => s.codecType === "audio");
