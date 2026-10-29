// mediatool 调用端：经共享目录里的 Unix 套接字调隔离容器的三个操作，并校验它的输出（D5 第 6.6 节；X-02）。
//
// 是独立的客户端，不在 types.ts 的十二个接口里（X-02 任务书 第 11 节第 1 项）：怎样挂到 media 接口由 G3-A 定，
// 挂上之后才有外呼前钩子。镜像、容器内服务与验证办法见 infra/docker/mediatool/README.md。
//
// 容器是用来解析任意用户上传的文件的，要按“可能已经被攻破”来对待它的输出：
//   应答      不超过 4MB，过 Zod；结构不符即拒收
//   封面      调用端自己从共享目录读：是普通文件、不经过符号链接、不超过 1MB、是 JPEG；返回的就是校验过的那份字节
//   加标产物  调用端自己量大小：与输入相差不超过 1MB；回读到的 AIGC 与写入的逐字节相同
// 结果照 providers 的约定返回 ProviderResult，不抛错：
//   unavailable  容器连不上、没应答、排队满、超时、子进程被系统杀掉、内部错误：可以重试
//   rejected     入参不合规、文件解不开、输出没通过上面的校验：重试也不会成

import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

import type { z } from "zod";

import { failed, ok } from "../types.js";
import type { MediaToolClient, ProviderFailure, ProviderResult } from "../types.js";
import {
  AigcLabelSchema,
  HealthResponseSchema,
  MEDIATOOL_DEMUXERS,
  MEDIATOOL_LIMITS,
  PosterResponseSchema,
  ProbeResponseSchema,
  StampResponseSchema,
  WatermarkPngResponseSchema,
  DocTextResponseSchema,
} from "./schema.js";
import { validWatermarkPng } from "./png.js";

/** 共享目录在调用端容器里的挂载点，与套接字的位置（D5 第 6.6 节） */
export const MEDIATOOL_WORK_DIR = "/work";
export const MEDIATOOL_SOCKET = "/work/.sock/mediatool.sock";

/** 容器那边每个操作的硬超时（毫秒）。调用端等应答的时间在它之上再留排队的余量 */
const HARD_TIMEOUT_MS = {
  probe: 30_000,
  poster: 30_000,
  stampAigc: 90_000,
  health: 5_000,
  watermarkPng: 30_000,
  watermarkSample: 90_000,
  docText: 10_000,
} as const;
const QUEUE_ALLOWANCE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 容器报的这几种失败可以重试，其余的重试也不会成 */
const RETRYABLE_CODES = new Set(["busy", "timeout", "killed", "internal"]);

/** 与容器内服务同一条规则：每段字母数字开头，只含字母、数字、点、下划线、连字符；至少“任务目录/文件名”两段 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MediaToolClientOptions {
  /** 套接字路径，缺省 /work/.sock/mediatool.sock */
  socketPath?: string;
  /** 共享目录在调用端这边的路径，缺省 /work */
  workDir?: string;
  /** 等一次应答的上限（毫秒）。缺省按操作取：容器的硬超时加 30 秒 */
  responseTimeoutMs?: number;
  /** Factory-only directory cleanup barrier; never exposed to a media domain. */
  observeCleanup?: (directory: string, completion: Promise<boolean>) => void;
}

export type { MediaToolClient, PosterResult, StampResult } from "../types.js";

function isRelativeWorkPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  const segments = path.split("/");
  return segments.length >= 2 && segments.every((segment) => SEGMENT.test(segment));
}

/** JPEG 的起止标记都在，且读得到尺寸（第一个 SOF 段）。不是 JPEG 返回 null */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) return null;
  if (view[view.length - 2] !== 0xff || view[view.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 9 < view.length && view[offset] === 0xff) {
    const marker = view[offset + 1] ?? 0;
    // SOF0–SOF15，除去 DHT（C4）、JPG（C8）、DAC（CC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.readUInt16BE(offset + 5);
      const width = view.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + view.readUInt16BE(offset + 2);
  }
  return null;
}

type Exchange = ProviderResult<{ status: number; body: unknown }>;

/** 发一次请求，收一个不超过 4MB 的 JSON。任何失败都落成结果，不抛 */
function exchange(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  observe?: (completion: Promise<boolean>) => void,
): Promise<Exchange> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(failed("unavailable", "mediatool调用已取消"));
      return;
    }
    const data = payload === undefined ? "" : JSON.stringify(payload);
    const requestId = randomUUID();
    let confirm!: (value: boolean) => void;
    observe?.(
      new Promise<boolean>((done) => {
        confirm = done;
      }),
    );
    let settled = false,
      responding = false,
      cancelling = false;
    let instance: string | undefined;
    let cancelRequest: http.ClientRequest | undefined;
    const settle = (result: Exchange, confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      confirm?.(confirmed);
      request.destroy();
      cancelRequest?.destroy();
      resolve(result);
    };
    const cancelled = () => failed("unavailable", "mediatool调用已取消");
    const cancel = () => {
      if (!cancelling || !instance || cancelRequest || settled) return;
      const expectedInstance = instance;
      const body = JSON.stringify({ requestId, instanceId: expectedInstance });
      cancelRequest = http.request(
        {
          socketPath,
          method: "POST",
          path: "/cancel",
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024) cancelRequest?.destroy();
            else chunks.push(chunk);
          });
          res.on("error", () => undefined);
          res.on("end", () => {
            try {
              const ack: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (
                res.statusCode === 200 &&
                ack !== null &&
                typeof ack === "object" &&
                "done" in ack &&
                ack.done === true &&
                "requestId" in ack &&
                ack.requestId === requestId &&
                "instanceId" in ack &&
                ack.instanceId === expectedInstance
              )
                settle(cancelled(), true);
            } catch {
              /* The original response still has the same remaining absolute budget. */
            }
          });
        },
      );
      cancelRequest.on("error", () => undefined);
      cancelRequest.end(body);
    };
    const request = http.request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          "x-lyx-call-id": requestId,
        },
      },
      (response) => {
        responding = true;
        const chunks: Buffer[] = [];
        let bytes = 0;
        const confirmed =
          response.headers["x-lyx-call-id"] === requestId &&
          response.headers["x-lyx-complete"] === "1" &&
          typeof response.headers["x-lyx-instance"] === "string" &&
          UUID.test(response.headers["x-lyx-instance"]) &&
          (!instance || response.headers["x-lyx-instance"] === instance);
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MEDIATOOL_LIMITS.maxResponseBytes) {
            settle(failed("rejected", "mediatool 的应答超过 4MB"), confirmed);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (cancelling) {
            if (confirmed) settle(cancelled(), true);
            return;
          }
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            settle(ok({ status: response.statusCode ?? 0, body }), confirmed);
          } catch {
            settle(failed("rejected", "mediatool 的应答不是 JSON"), confirmed);
          }
        });
        response.on("error", () => {
          if (!cancelling || !instance)
            settle(failed("unavailable", "mediatool 的应答中途断开"), false);
        });
        response.on("close", () => {
          if (!settled && (!cancelling || !instance))
            settle(failed("unavailable", "mediatool 的应答中途断开"), false);
        });
      },
    );
    request.on("information", (info) => {
      if (
        info.statusCode === 102 &&
        info.headers["x-lyx-call-id"] === requestId &&
        typeof info.headers["x-lyx-instance"] === "string" &&
        UUID.test(info.headers["x-lyx-instance"])
      ) {
        instance = info.headers["x-lyx-instance"];
        cancel();
      }
    });
    const timer = setTimeout(
      () => settle(failed("unavailable", `mediatool 在 ${timeoutMs}ms 内没有应答`), false),
      timeoutMs,
    );
    const abort = () => {
      cancelling = true;
      cancel();
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (err: NodeJS.ErrnoException) => {
      if (!cancelling || !instance)
        settle(
          failed(
            "unavailable",
            responding
              ? "mediatool 的应答中途断开"
              : `mediatool 连不上（${err.code ?? err.message}）`,
          ),
          false,
        );
    });
    if (signal?.aborted) abort();
    request.end(data);
  });
}

/** 应答过 Zod；容器报的失败按代码分成可重试与不可重试 */
function interpret<S extends z.ZodType<{ ok: boolean }>>(
  schema: S,
  exchanged: Exchange,
): ProviderResult<Extract<z.infer<S>, { ok: true }>> {
  if (!exchanged.ok) return exchanged;
  const parsed = schema.safeParse(exchanged.value.body);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") ?? "";
    return failed("rejected", `mediatool 的应答结构不符${where ? `（${where}）` : ""}`);
  }
  const data = parsed.data;
  if (data.ok) return ok(data as Extract<z.infer<S>, { ok: true }>);
  const { code, message } = (data as unknown as { error: { code: string; message: string } }).error;
  const retryable = RETRYABLE_CODES.has(code) || exchanged.value.status >= 500;
  return failed(retryable ? "unavailable" : "rejected", `mediatool ${code}：${message}`);
}

/**
 * 共享目录下的一个产物：必须是普通文件，路径上不经过符号链接。返回绝对路径与大小；不合规返回原因。
 * 容器能在共享目录里放任何东西，包括指向调用端自己文件的符号链接。
 */
async function regularFile(
  workDir: string,
  relative: string,
): Promise<{ abs: string; sizeBytes: number } | ProviderFailure> {
  try {
    const abs = join(await realpath(workDir), ...relative.split("/"));
    if ((await realpath(abs)) !== abs) return failed("rejected", `${relative} 经过符号链接`);
    const stat = await lstat(abs);
    if (!stat.isFile()) return failed("rejected", `${relative} 不是普通文件`);
    return { abs, sizeBytes: stat.size };
  } catch {
    return failed("rejected", `${relative} 不存在或读不了`);
  }
}

/** 读整个文件，最多读 limit + 1 字节（多出的那 1 字节用来发现超限）。打开时不跟随符号链接 */
async function readCapped(abs: string, limit: number): Promise<Uint8Array> {
  const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return new Uint8Array(buffer.subarray(0, filled));
  } finally {
    await handle.close();
  }
}

export function createMediaToolClient(options: MediaToolClientOptions = {}): MediaToolClient {
  const socketPath = options.socketPath ?? MEDIATOOL_SOCKET;
  const workDir = options.workDir ?? MEDIATOOL_WORK_DIR;
  const waitFor = (op: keyof typeof HARD_TIMEOUT_MS) =>
    options.responseTimeoutMs ?? HARD_TIMEOUT_MS[op] + QUEUE_ALLOWANCE_MS;
  const call = (
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    timeout: number,
    signal?: AbortSignal,
  ) =>
    exchange(
      socketPath,
      method,
      path,
      payload,
      timeout,
      signal,
      options.observeCleanup && payload !== null && typeof payload === "object"
        ? (completion) => {
            const value = payload as { path?: string; outPath?: string };
            const file = value.path ?? value.outPath;
            if (file) options.observeCleanup?.(file.split("/")[0]!, completion);
          }
        : undefined,
    );
  const badPath = (name: string) =>
    failed("rejected", `${name} 要是共享目录下的相对路径（任务目录/文件名），不带 .. 与绝对路径`);
  const knownDemuxer = (value: unknown) =>
    (MEDIATOOL_DEMUXERS as readonly unknown[]).includes(value);

  return {
    async docText(input) {
      if (!isRelativeWorkPath(input.path)) return badPath("path");
      if (
        !["pdf", "docx", "txt"].includes(input.ext) ||
        !Number.isInteger(input.maxChars) ||
        input.maxChars < 1 ||
        input.maxChars > 250_000 ||
        (input.timeoutMs !== undefined &&
          (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000))
      )
        return failed("rejected", "文档参数不合规");
      const result = interpret(
        DocTextResponseSchema,
        await call(
          "POST",
          "/docText",
          {
            path: input.path,
            ext: input.ext,
            maxChars: input.maxChars,
            timeoutMs: Math.min(input.timeoutMs ?? 10_000, 10_000),
          },
          waitFor("docText"),
          input.signal,
        ),
      );
      if (!result.ok) return result;
      const { ok: _, ...facts } = result.value;
      if (
        Array.from(facts.text).length !== Math.min(input.maxChars, facts.charCount) ||
        (input.ext === "pdf" ? facts.pageCount === undefined : facts.pageCount !== undefined)
      )
        return failed("rejected", "文档截断或页数事实不一致");
      return ok(facts);
    },
    async probe(input) {
      if (!isRelativeWorkPath(input.path)) return badPath("path");
      if (
        input.demuxers.length < 1 ||
        input.demuxers.length > 3 ||
        !input.demuxers.every(knownDemuxer)
      ) {
        return failed("rejected", `demuxers 要给 1–3 个，只认 ${MEDIATOOL_DEMUXERS.join("、")}`);
      }
      const body = { path: input.path, demuxers: input.demuxers, timeoutMs: input.timeoutMs };
      const result = interpret(
        ProbeResponseSchema,
        await call("POST", "/probe", body, waitFor("probe"), input.signal),
      );
      return result.ok ? ok(result.value.report) : result;
    },

    async poster(input) {
      if (!isRelativeWorkPath(input.path)) return badPath("path");
      if (!isRelativeWorkPath(input.outPath)) return badPath("outPath");
      if (!knownDemuxer(input.demuxer)) return failed("rejected", "不认识的解复用器");
      const body = {
        path: input.path,
        demuxer: input.demuxer,
        atMs: input.atMs,
        outPath: input.outPath,
        timeoutMs: input.timeoutMs,
      };
      const result = interpret(
        PosterResponseSchema,
        await call("POST", "/poster", body, waitFor("poster"), input.signal),
      );
      if (!result.ok) return result;
      const file = await regularFile(workDir, input.outPath);
      if ("ok" in file) return file;
      if (file.sizeBytes > MEDIATOOL_LIMITS.maxPosterBytes) {
        return failed("rejected", `封面 ${file.sizeBytes} 字节，超过 1MB`);
      }
      try {
        const bytes = await readCapped(file.abs, MEDIATOOL_LIMITS.maxPosterBytes);
        if (bytes.length > MEDIATOOL_LIMITS.maxPosterBytes) {
          return failed("rejected", "封面超过 1MB");
        }
        const size = jpegDimensions(bytes);
        if (!size) return failed("rejected", "封面不是合法的 JPEG");
        return ok({ bytes, sizeBytes: bytes.length, ...size, atMs: result.value.atMs });
      } catch {
        return failed("rejected", "封面读不了");
      }
    },

    async stampAigc(input) {
      if (!isRelativeWorkPath(input.path)) return badPath("path");
      if (!isRelativeWorkPath(input.outPath)) return badPath("outPath");
      let label: unknown;
      try {
        label = JSON.parse(input.aigcJson);
      } catch {
        label = undefined;
      }
      if (!AigcLabelSchema.safeParse(label).success) {
        return failed("rejected", "aigcJson 要是七个字段的 JSON（用 aigcMetadataJson 生成）");
      }
      const body = {
        path: input.path,
        outPath: input.outPath,
        aigcJson: input.aigcJson,
        timeoutMs: input.timeoutMs,
      };
      const result = interpret(
        StampResponseSchema,
        await call("POST", "/stampAigc", body, waitFor("stampAigc"), input.signal),
      );
      if (!result.ok) return result;
      const { report } = result.value;
      if (report.aigc !== input.aigcJson) {
        return failed("rejected", "加标产物里读回的 AIGC 与写入的不一致");
      }
      const source = await regularFile(workDir, input.path);
      if ("ok" in source) return source;
      const product = await regularFile(workDir, input.outPath);
      if ("ok" in product) return product;
      const delta = Math.abs(product.sizeBytes - source.sizeBytes);
      if (delta > MEDIATOOL_LIMITS.maxStampDeltaBytes) {
        return failed(
          "rejected",
          `加标产物 ${product.sizeBytes} 字节，与输入 ${source.sizeBytes} 字节相差超过 1MB`,
        );
      }
      return ok({ report, inputSizeBytes: source.sizeBytes, outputSizeBytes: product.sizeBytes });
    },

    async watermarkSample(input) {
      if (input.signal?.aborted) return failed("unavailable", "样片水印调用已取消");
      if (
        !isRelativeWorkPath(input.path) ||
        !isRelativeWorkPath(input.outPath) ||
        input.path.split("/")[0] !== input.outPath.split("/")[0] ||
        input.path === input.outPath ||
        !input.outPath.endsWith(".mp4") ||
        typeof input.text !== "string" ||
        Buffer.byteLength(input.text) > 256 ||
        /[\p{Cc}\p{Cf}]/u.test(input.text) ||
        !/^样片 · 仅供「.{1,20}」确认 · \d{2}-\d{2}$/u.test(input.text) ||
        (input.timeoutMs !== undefined &&
          (!Number.isInteger(input.timeoutMs) ||
            input.timeoutMs < 1000 ||
            input.timeoutMs > HARD_TIMEOUT_MS.watermarkSample))
      )
        return failed("rejected", "样片水印参数或路径不合规");
      const source = await regularFile(workDir, input.path);
      if ("ok" in source) return source;
      if (source.sizeBytes < 1 || source.sizeBytes > 200 * 1024 ** 2)
        return failed("rejected", "样片源文件超限");
      const result = interpret(
        StampResponseSchema,
        await call(
          "POST",
          "/watermarkSample",
          {
            path: input.path,
            outPath: input.outPath,
            text: input.text,
            timeoutMs: input.timeoutMs,
          },
          waitFor("watermarkSample"),
          input.signal,
        ),
      );
      if (!result.ok) return result;
      const product = await regularFile(workDir, input.outPath);
      if ("ok" in product) return product;
      const report = result.value.report;
      const videos = report.streams.filter((stream) => stream.codecType === "video");
      const audios = report.streams.filter((stream) => stream.codecType === "audio");
      const video = videos[0];
      if (
        product.sizeBytes < 1 ||
        product.sizeBytes > 200 * 1024 ** 2 ||
        result.value.inputSizeBytes !== source.sizeBytes ||
        result.value.outputSizeBytes !== product.sizeBytes ||
        report.format.sizeBytes !== product.sizeBytes ||
        !report.moovBeforeMdat ||
        videos.length !== 1 ||
        audios.length !== 1 ||
        video?.codecName !== "h264" ||
        video.profile !== "High" ||
        video.pixFmt !== "yuv420p" ||
        video.rotation !== 0 ||
        !video.displayWidth ||
        !video.displayHeight ||
        audios[0]?.codecName !== "aac"
      )
        return failed("rejected", "样片水印产物与回读报告不一致");
      try {
        const handle = await open(product.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size !== product.sizeBytes)
            return failed("rejected", "样片水印产物已改变");
          const hash = createHash("sha256"),
            chunk = Buffer.alloc(64 * 1024);
          let size = 0;
          while (true) {
            if (input.signal?.aborted) return failed("unavailable", "样片水印调用已取消");
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > product.sizeBytes) return failed("rejected", "样片水印产物已改变");
            hash.update(chunk.subarray(0, bytesRead));
          }
          if (size !== product.sizeBytes) return failed("rejected", "样片水印产物已改变");
          return ok({
            report,
            inputSizeBytes: source.sizeBytes,
            outputSizeBytes: product.sizeBytes,
            sha256: hash.digest("hex"),
          });
        } finally {
          await handle.close();
        }
      } catch {
        return failed("rejected", "样片水印产物读取失败");
      }
    },

    async watermarkPng(input) {
      if (
        !isRelativeWorkPath(input.outPath) ||
        !input.outPath.endsWith("/watermark.png") ||
        typeof input.text !== "string" ||
        Buffer.byteLength(input.text) > 256 ||
        /[\p{Cc}\p{Cf}]/u.test(input.text)
      )
        return badPath("watermark");
      const result = interpret(
        WatermarkPngResponseSchema,
        await call(
          "POST",
          "/watermarkPng",
          { outPath: input.outPath, text: input.text },
          waitFor("watermarkPng"),
          input.signal,
        ),
      );
      if (!result.ok) return result;
      const file = await regularFile(workDir, input.outPath);
      if ("ok" in file) return file;
      try {
        const bytes = await readCapped(file.abs, 1024 ** 2);
        if (bytes.length !== result.value.sizeBytes || !validWatermarkPng(bytes))
          return failed("rejected", "水印PNG结构或实际像素不合法");
        return ok({
          sizeBytes: bytes.length,
          width: 720,
          height: 96,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch {
        return failed("rejected", "水印PNG读取失败");
      }
    },
    async health(signal) {
      const result = interpret(
        HealthResponseSchema,
        await call("GET", "/healthz", undefined, waitFor("health"), signal),
      );
      return result.ok
        ? ok({ ffmpeg: result.value.ffmpeg, ffprobe: result.value.ffprobe })
        : result;
    },
  };
}
