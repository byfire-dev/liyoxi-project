// @ts-check
// 请求里的路径：只接受共享目录下的相对路径（D5 第 6.6 节“调用方式”）。
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 与调用端共享的目录，容器里唯一可写的挂载 */
export const WORK_ROOT = "/work";
/** 套接字所在的目录。段名不许以点开头，所以请求碰不到它 */
export const SOCKET_PATH = `${WORK_ROOT}/.sock/mediatool.sock`;

/** 每一段：字母数字开头，只含字母、数字、点、下划线、连字符。“..”、绝对路径、隐藏文件、反斜杠、冒号、百分号都过不了 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 请求有问题：带一个调用端认得的代码与 HTTP 状态码 */
export class RequestError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * 相对路径拆成段并逐段核对。至少两段：任务目录加文件名（输出都写回 /work/{jobId}/）。
 * @param {unknown} rel
 * @returns {string[]}
 */
export function segmentsOf(rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 512) {
    throw new RequestError("bad_path", "路径要是共享目录下的相对路径");
  }
  const segments = rel.split("/");
  if (segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment))) {
    throw new RequestError("bad_path", `路径不合规：${rel.slice(0, 80)}`);
  }
  return segments;
}

/**
 * 输入文件：必须已经在共享目录里，是普通文件，解析符号链接之后还是原来的位置。
 * @param {unknown} rel
 * @returns {Promise<{ abs: string, jobDir: string, sizeBytes: number }>}
 */
export async function inputFile(rel) {
  const segments = segmentsOf(rel);
  const abs = join(WORK_ROOT, ...segments);
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw new RequestError("not_found", `没有这个文件：${rel}`, 404);
  }
  if (real !== abs) throw new RequestError("bad_path", "路径经过符号链接");
  const stat = await lstat(abs);
  if (!stat.isFile()) throw new RequestError("bad_path", "不是普通文件");
  return { abs, jobDir: String(segments[0]), sizeBytes: stat.size };
}

/**
 * 输出文件：与输入同一个任务目录，上级目录已经存在且不经过符号链接。
 * @param {unknown} rel
 * @param {string} jobDir 输入所在的任务目录
 * @returns {Promise<string>}
 */
export async function outputFile(rel, jobDir) {
  const segments = segmentsOf(rel);
  if (segments[0] !== jobDir) {
    throw new RequestError("bad_path", "输出要写回输入所在的任务目录");
  }
  const abs = join(WORK_ROOT, ...segments);
  let realDir;
  try {
    realDir = await realpath(dirname(abs));
  } catch {
    throw new RequestError("bad_path", "输出的上级目录不存在");
  }
  if (realDir !== dirname(abs)) throw new RequestError("bad_path", "路径经过符号链接");
  return join(realDir, basename(abs));
}
