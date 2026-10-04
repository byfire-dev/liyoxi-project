// @ts-check
// 跑一个子进程并等它退出：自成进程组，硬超时到点向整组发 SIGKILL；标准输出有上限，标准错误只留尾部。
// “超时杀进程组、错误输出截尾、内存见底时先杀子进程”的写法参考了参考工程 packages/services/src/render/process.ts；
// 那边的 systemd-run 与 cgroup 部分没有借：这里的内存与进程数上限由容器给。
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

/** 在跑的子进程。服务收到终止信号时一并杀掉 */
export const children = new Set();

const STDERR_TAIL_BYTES = 8 * 1024;
/** 子进程只拿到这两个环境变量，不继承服务进程的 */
const CHILD_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" };

/**
 * @typedef {object} RunResult
 * @property {number | null} code 退出码；被信号杀掉时为 null（到点被本服务杀、输出超限被杀、内存不够被内核杀）
 * @property {Buffer} stdout
 * @property {string} stderrTail 标准错误的最后 8KB
 * @property {boolean} timedOut 到了硬超时被杀
 * @property {boolean} overflow 标准输出超过上限被杀
 */

/**
 * 向整个进程组发 SIGKILL。ffmpeg 卡在读写上时 SIGTERM 不一定叫得醒它。
 * @param {import("node:child_process").ChildProcess} child
 */
export function killGroup(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * 参数以数组交给 spawn，不经过 shell。
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs: number, maxStdoutBytes: number }} limits
 * @returns {Promise<RunResult>}
 */
export function run(bin, args, limits) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: CHILD_ENV,
    });
    children.add(child);
    // 容器的内存见底时让内核先杀这个子进程，不要杀服务进程（它是 1 号进程，它一死容器就退出了）。写不进去就算了
    if (child.pid !== undefined) {
      writeFile(`/proc/${child.pid}/oom_score_adj`, "1000").catch(() => undefined);
    }
    /** @type {Buffer[]} */
    const out = [];
    let outBytes = 0;
    let tail = Buffer.alloc(0);
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, limits.timeoutMs);

    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      outBytes += chunk.length;
      if (outBytes > limits.maxStdoutBytes) {
        overflow = true;
        killGroup(child);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderrTail: tail.toString("utf8"),
        timedOut,
        overflow,
      });
    });
  });
}
