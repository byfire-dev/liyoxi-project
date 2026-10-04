// @ts-check
// 三个操作：probe（体检）、poster（抽一帧封面）、stampAigc（写 AI 隐式标识并回读）。约定见 D5 第 6.2、6.6 节。
// 借自参考工程（提交 f1361e3）：
//   packages/services/src/render/finalize.ts 的加标参数（-map 0 -c copy -metadata AIGC=… -movflags +faststart+use_metadata_tags）；
//   packages/services/src/media/probe.ts 的 readRotation（旋转后的显示尺寸）与 seekTo（第 0 秒不写 -ss）。
// 比参考工程多的是 D5 第 6.6 节的输入约束：协议白名单、强制解复用器、不跟随外部引用、探测上限、硬超时。
import { rename, rm, stat } from "node:fs/promises";

import { moovBeforeMdat, topLevelBoxTypes } from "./boxes.mjs";
import { RequestError, inputFile, outputFile } from "./paths.mjs";
import { run } from "./run.mjs";

export const LIMITS = {
  /** 每次调用的硬超时（D5：30–90 秒）。请求里的 timeoutMs 只能把它调短 */
  probeTimeoutMs: 30_000,
  posterTimeoutMs: 30_000,
  stampTimeoutMs: 90_000,
  minTimeoutMs: 1_000,
  /** ffprobe 的输出上限：调用端只收 4MB 以内的 JSON */
  maxReportBytes: 4 * 1024 * 1024,
  maxPosterBytes: 1024 * 1024,
  maxAigcBytes: 2048,
  /** 探测上限：最多读 5MB、分析 5 秒（单位微秒） */
  probesize: 5_000_000,
  analyzedurationUs: 5_000_000,
};

/** 允许强制的解复用器，与各自的附加参数。调用端按登记的扩展名选（mp4 / mov / m4a → mov） */
const DEMUXERS = /** @type {const} */ ({
  // 不跟随外部引用，也不认绝对路径
  mov: ["-enable_drefs", "0", "-use_absolute_path", "0"],
  mp3: [],
  wav: [],
  aac: [],
});

/** 封面超过 1MB 时依次调低画质重出 */
const POSTER_QUALITIES = [5, 12, 24];

/**
 * 输入参数：只许 file 协议（没有任何网络协议，也没有 concat、subfile、data），强制解复用器，探测有上限。
 * 路径带 file: 前缀，文件名里有什么字符都不会被当成别的协议。
 * @param {keyof typeof DEMUXERS} demuxer
 * @param {string} abs
 */
function inputArgs(demuxer, abs) {
  return [
    "-protocol_whitelist",
    "file",
    "-probesize",
    String(LIMITS.probesize),
    "-analyzeduration",
    String(LIMITS.analyzedurationUs),
    "-f",
    demuxer,
    ...DEMUXERS[demuxer],
    "-i",
    `file:${abs}`,
  ];
}

/**
 * 这次调用还剩多少毫秒；到点即抛。一次调用里的几个子进程共用一个期限。
 * @param {number} capMs
 * @param {unknown} requested
 */
function deadline(capMs, requested) {
  let total = capMs;
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || Number(requested) < LIMITS.minTimeoutMs) {
      throw new RequestError("bad_request", `timeoutMs 要是不小于 ${LIMITS.minTimeoutMs} 的整数`);
    }
    total = Math.min(capMs, Number(requested));
  }
  const end = Date.now() + total;
  return () => {
    const left = end - Date.now();
    if (left <= 0) throw new RequestError("timeout", "超过硬超时", 504);
    return left;
  };
}

/** @param {string} stderr */
const tailOf = (stderr) => stderr.trim().replace(/\s+/g, " ").slice(-300);

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {() => number} left
 */
async function tool(bin, args, left) {
  const result = await run(bin, args, {
    timeoutMs: left(),
    maxStdoutBytes: LIMITS.maxReportBytes,
  });
  if (result.timedOut) throw new RequestError("timeout", `${bin} 超过硬超时，已杀掉进程组`, 504);
  if (result.overflow) throw new RequestError("output_too_large", `${bin} 的输出超过 4MB`, 422);
  // 不是本服务杀的，却死于信号：多半是容器内存见底，被内核挑中
  if (result.code === null) throw new RequestError("killed", `${bin} 被系统杀掉了`, 503);
  return result;
}

/** @param {unknown} value */
function demuxerOf(value) {
  if (typeof value === "string" && Object.hasOwn(DEMUXERS, value)) {
    return /** @type {keyof typeof DEMUXERS} */ (value);
  }
  throw new RequestError("bad_request", `解复用器只认 ${Object.keys(DEMUXERS).join("、")}`);
}

// ---------- 体检报告 ----------

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : null);
/** @param {unknown} value */
const int = (value) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};
/** 秒（ffprobe 给的是字符串）→ 毫秒 @param {unknown} value */
const ms = (value) => {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
};

/**
 * 旋转角度，归一到 0 / 90 / 180 / 270。两处都可能有，且正负号约定相反（rotate 标签常见 90，
 * 显示矩阵常见 -90），说的是同一件事，所以取绝对值：判横竖只关心转没转四分之一圈。
 * @param {any} stream
 */
function readRotation(stream) {
  const sides = Array.isArray(stream?.side_data_list) ? stream.side_data_list : [];
  const side = sides.find((/** @type {any} */ data) => typeof data?.rotation === "number");
  const tag = Number(stream?.tags?.rotate);
  const raw = side ? side.rotation : Number.isFinite(tag) ? tag : 0;
  return Math.abs(Math.round(raw)) % 360;
}

/** @param {any} stream */
function streamOf(stream) {
  const rotation = readRotation(stream);
  const swap = rotation % 180 === 90;
  const width = int(stream.width);
  const height = int(stream.height);
  return {
    index: int(stream.index),
    codecType: text(stream.codec_type),
    codecName: text(stream.codec_name),
    profile: text(stream.profile),
    pixFmt: text(stream.pix_fmt),
    bitsPerRawSample: int(stream.bits_per_raw_sample),
    // 编码尺寸（旋转前）与显示尺寸（旋转后）：判横竖只能用后者
    width,
    height,
    rotation,
    displayWidth: swap ? height : width,
    displayHeight: swap ? width : height,
    sampleAspectRatio: text(stream.sample_aspect_ratio),
    rFrameRate: text(stream.r_frame_rate),
    avgFrameRate: text(stream.avg_frame_rate),
    nbFrames: int(stream.nb_frames),
    startTimeMs: ms(stream.start_time),
    durationMs: ms(stream.duration),
    bitRate: int(stream.bit_rate),
    sampleRate: int(stream.sample_rate),
    channels: int(stream.channels),
    attachedPic: stream.disposition?.attached_pic === 1,
  };
}

/**
 * @param {keyof typeof DEMUXERS} demuxer
 * @param {any} raw ffprobe 的 JSON
 * @param {string[]} boxes
 * @param {number} sizeBytes
 */
function reportOf(demuxer, raw, boxes, sizeBytes) {
  const format = raw?.format ?? {};
  /** @type {Record<string, string>} */
  const tags = {};
  for (const [key, value] of Object.entries(format.tags ?? {})) {
    if (typeof value === "string") tags[key] = value;
  }
  const aigcKey = Object.keys(tags).find((key) => key.toLowerCase() === "aigc");
  return {
    demuxer,
    format: {
      formatName: text(format.format_name),
      majorBrand: tags.major_brand ?? null,
      durationMs: ms(format.duration),
      sizeBytes,
      bitRate: int(format.bit_rate),
      tags,
    },
    streams: (Array.isArray(raw?.streams) ? raw.streams : []).map(streamOf),
    // 顶层 box 的顺序，只对 mov 一族有意义
    boxes,
    moovBeforeMdat: moovBeforeMdat(boxes),
    // AI 隐式标识：原样的字符串。解析与逐字段核对由调用端做
    aigc: aigcKey === undefined ? null : (tags[aigcKey] ?? null),
  };
}

/**
 * @param {string} abs
 * @param {number} sizeBytes
 * @param {(keyof typeof DEMUXERS)[]} demuxers 依次尝试，第一个解得开的算数
 * @param {() => number} left
 */
async function probeFile(abs, sizeBytes, demuxers, left) {
  let reason = "";
  for (const demuxer of demuxers) {
    const args = ["-hide_banner", "-v", "error", ...inputArgs(demuxer, abs)];
    const result = await tool(
      "ffprobe",
      [...args, "-show_format", "-show_streams", "-of", "json"],
      left,
    );
    if (result.code !== 0) {
      reason = tailOf(result.stderrTail);
      continue;
    }
    try {
      const raw = JSON.parse(result.stdout.toString("utf8"));
      const boxes = demuxer === "mov" ? await topLevelBoxTypes(abs, sizeBytes) : [];
      return reportOf(demuxer, raw, boxes, sizeBytes);
    } catch {
      reason = "ffprobe 的输出不是 JSON";
    }
  }
  throw new RequestError("demux_failed", `按 ${demuxers.join("、")} 解不开：${reason}`, 422);
}

// ---------- 三个操作 ----------

/** @param {any} body */
export async function probe(body) {
  const left = deadline(LIMITS.probeTimeoutMs, body.timeoutMs);
  const list = Array.isArray(body.demuxers) ? body.demuxers : [];
  if (list.length < 1 || list.length > 3) {
    throw new RequestError("bad_request", "demuxers 要给 1–3 个");
  }
  const demuxers = list.map(demuxerOf);
  const input = await inputFile(body.path);
  return { report: await probeFile(input.abs, input.sizeBytes, demuxers, left) };
}

/**
 * 抽 atMs 处的一帧存成 JPEG（宽不超过 1080，带旋转元数据的按旋转后出图）。
 * 片子比 atMs 短时抽不到帧，退回抽第一帧；第 0 秒不写 -ss。
 * @param {any} body
 */
export async function poster(body) {
  const left = deadline(LIMITS.posterTimeoutMs, body.timeoutMs);
  const demuxer = demuxerOf(body.demuxer);
  if (!Number.isInteger(body.atMs) || body.atMs < 0 || body.atMs > 86_400_000) {
    throw new RequestError("bad_request", "atMs 要是 0 到一天之内的整数毫秒");
  }
  const input = await inputFile(body.path);
  const out = await outputFile(body.outPath, input.jobDir);
  const part = `${out}.part`;
  try {
    for (const atMs of body.atMs > 0 ? [body.atMs, 0] : [0]) {
      for (const quality of POSTER_QUALITIES) {
        await rm(part, { force: true });
        const seek = atMs > 0 ? ["-ss", (atMs / 1000).toFixed(3)] : [];
        const result = await tool(
          "ffmpeg",
          [
            ...["-hide_banner", "-v", "error", "-nostdin", "-y", "-threads", "1"],
            ...seek,
            ...inputArgs(demuxer, input.abs),
            ...["-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-filter_threads", "1"],
            ...["-vf", "scale='min(1080,iw)':-2:out_range=pc,format=yuvj420p"],
            ...["-c:v", "mjpeg", "-q:v", String(quality), "-threads", "1"],
            ...["-f", "image2", "-update", "1", `file:${part}`],
          ],
          left,
        );
        if (result.code !== 0) {
          throw new RequestError("demux_failed", `抽帧失败：${tailOf(result.stderrTail)}`, 422);
        }
        const sizeBytes = (await stat(part).catch(() => null))?.size ?? 0;
        // 越过片尾的 -ss 会正常退出却一帧不出：换下一个时间点
        if (sizeBytes === 0) break;
        if (sizeBytes > LIMITS.maxPosterBytes) continue;
        await rename(part, out);
        return { sizeBytes, atMs };
      }
    }
  } finally {
    await rm(part, { force: true });
  }
  throw new RequestError("no_frame", "抽不出不超过 1MB 的一帧", 422);
}

/**
 * 流拷贝重封装，写入 AIGC 元数据，再回读。不重编码。
 * -movflags 里的 use_metadata_tags 不能少：不带它，mp4 封装器会把非标准的键静默丢掉。
 * 回读到的与写入的不一致即失败，并删掉产物。输入里已有标识时会被覆盖：要不要加标由调用端先体检再定。
 * @param {any} body
 */
export async function stampAigc(body) {
  const left = deadline(LIMITS.stampTimeoutMs, body.timeoutMs);
  const aigcJson = body.aigcJson;
  if (
    typeof aigcJson !== "string" ||
    Buffer.byteLength(aigcJson) > LIMITS.maxAigcBytes ||
    // 不许有控制字符（换行、NUL 之类）
    Array.from(aigcJson).some((char) => char.charCodeAt(0) < 0x20)
  ) {
    throw new RequestError(
      "bad_request",
      `aigcJson 要是不超过 ${LIMITS.maxAigcBytes} 字节的一行 JSON`,
    );
  }
  const input = await inputFile(body.path);
  const out = await outputFile(body.outPath, input.jobDir);
  if (out === input.abs) throw new RequestError("bad_path", "输出不能与输入是同一个文件");
  const part = `${out}.part`;
  try {
    const result = await tool(
      "ffmpeg",
      [
        ...["-hide_banner", "-v", "error", "-nostdin", "-y"],
        ...inputArgs("mov", input.abs),
        ...["-map", "0", "-c", "copy", "-metadata", `AIGC=${aigcJson}`],
        ...["-movflags", "+faststart+use_metadata_tags", "-f", "mp4", `file:${part}`],
      ],
      left,
    );
    if (result.code !== 0) {
      throw new RequestError("remux_failed", `重封装失败：${tailOf(result.stderrTail)}`, 422);
    }
    const outputSizeBytes = (await stat(part)).size;
    const report = await probeFile(part, outputSizeBytes, ["mov"], left);
    if (report.aigc !== aigcJson) {
      throw new RequestError("aigc_not_readable", "写入的 AIGC 读不回来", 422);
    }
    await rename(part, out);
    return { report, inputSizeBytes: input.sizeBytes, outputSizeBytes };
  } finally {
    await rm(part, { force: true });
  }
}
