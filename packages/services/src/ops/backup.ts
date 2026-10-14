// D7 §7.8：无 shell、无明文落盘的只读 pg_dump → age → 备份存储。
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { calendarDate } from "@liyoxi/shared/time";
import { assertNotInTransaction } from "../kernel/index.js";
import type { Clock, Env } from "../kernel/index.js";
import type { StorageProvider } from "../providers/types.js";

export type BackupConfig = NonNullable<Env["BACKUP"]>;
export interface BackupSummary {
  readonly key: string;
  readonly bytes: number;
  readonly seconds: number;
  readonly pgDumpVersion: string;
}
export interface BackupChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  kill(signal: NodeJS.Signals): void;
}
/** 只给测试替换进程外部 IO；生产命令路径固定，配置中没有可执行文件或 shell 字段。 */
export type BackupProcessRunner = (
  command: "pg_dump" | "age",
  args: readonly string[],
  input: { readonly env: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => BackupChild;
const MAX_BYTES = 2 * 1024 ** 3,
  MAX_MS = 30 * 60 * 1000;
const failure = () => new Error("备份任务失败或已取消");
const versionPattern = /^(\d{1,2})(?:\.\d+){1,2}$/;
export function readBackupSummary(value: unknown): BackupSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "bytes,key,pgDumpVersion,seconds") return null;
  if (
    !("key" in value) ||
    !("bytes" in value) ||
    !("seconds" in value) ||
    !("pgDumpVersion" in value)
  )
    return null;
  const { key, bytes, seconds, pgDumpVersion } = value;
  if (
    typeof key !== "string" ||
    !/^daily\/\d{4}-\d{2}-\d{2}\.dump\.age$/.test(key) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > MAX_BYTES ||
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_MS / 1000 ||
    typeof pgDumpVersion !== "string" ||
    !versionPattern.test(pgDumpVersion) ||
    Number(pgDumpVersion.split(".")[0]) < 17
  )
    return null;
  const date = key.slice(6, 16),
    at = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== date) return null;
  return { key, bytes, seconds, pgDumpVersion };
}

const spawnProcess: BackupProcessRunner = (command, args, input) => {
  // 不继承 PATH、HOME、PGSERVICE/PGOPTIONS 等发现链；只允许固定镜像工具。
  const child = spawn(command === "pg_dump" ? "/usr/bin/pg_dump" : "/usr/bin/age", [...args], {
    shell: false,
    cwd: "/tmp",
    env: { ...input.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    signal: input.signal,
    killSignal: "SIGTERM",
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // error（尤其AbortError）不等于实际退出；只用close确认子进程及stdio均已收回。
    child.once("error", () => undefined);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
};
const cleanEnv = () => ({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  PGPASSFILE: "/dev/null",
  PGSERVICEFILE: "/dev/null",
});
function connection(value: string) {
  try {
    const url = new URL(value),
      database = decodeURIComponent(url.pathname.slice(1)),
      username = decodeURIComponent(url.username),
      password = decodeURIComponent(url.password);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.hash ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(database) ||
      !username ||
      [username, password, url.hostname].some((field) => /[\p{Cc}]/u.test(field))
    )
      throw failure();
    const env: Record<string, string> = {
      ...cleanEnv(),
      PGPASSWORD: password,
      PGOPTIONS: "-c default_transaction_read_only=on",
      PGCONNECT_TIMEOUT: "30",
    };
    const keys = new Set<string>();
    for (const [key, field] of url.searchParams) {
      if (keys.has(key)) throw failure();
      keys.add(key);
      if (
        key === "sslmode" &&
        ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(field)
      )
        env.PGSSLMODE = field;
      else if (
        key === "connect_timeout" &&
        /^\d+$/.test(field) &&
        Number(field) >= 1 &&
        Number(field) <= 30
      )
        env.PGCONNECT_TIMEOUT = field;
      else throw failure();
    }
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    return {
      env,
      args: [
        "-Fc",
        "--no-owner",
        "--no-password",
        "--role=lyx_readonly",
        `--host=${hostname}`,
        `--port=${url.port || "5432"}`,
        `--username=${username}`,
        `--dbname=${database}`,
      ],
    };
  } catch {
    throw failure();
  }
}
interface OwnedChild {
  child: BackupChild;
  exit: BackupChild["exited"];
  done: boolean;
}
function own(child: BackupChild): OwnedChild {
  const owned: OwnedChild = { child, exit: Promise.resolve(child.exited), done: false };
  owned.exit = owned.exit.then(
    (result) => {
      owned.done = true;
      return result;
    },
    () => {
      owned.done = true;
      return { code: null, signal: null };
    },
  );
  // 不保存/打印可能包含URL、账号和厂商提示的 stderr；只持续消费，内存上限为0。
  child.stderr.on("data", () => undefined);
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.on("error", () => undefined);
  return owned;
}
function stopNow(owned: OwnedChild) {
  if (!owned.done) {
    try {
      owned.child.kill("SIGTERM");
    } catch {
      /* 仍在回收阶段核验退出。 */
    }
  }
  owned.child.stdin.destroy();
  owned.child.stdout.destroy();
  owned.child.stderr.destroy();
}
/** 等待外部完成也受失租/关停约束；接住迟到结果，取消先进入真实进程回收。 */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(failure());
    };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(failure());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
async function waitExit(owned: OwnedChild, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function cleanup(owned: OwnedChild) {
  stopNow(owned);
  if (owned.done) return;
  if (await waitExit(owned, 1000)) return;
  try {
    owned.child.kill("SIGKILL");
  } catch {
    /* 下方仍核实退出，不能把kill调用当成功。 */
  }
  if (!(await waitExit(owned, 1000))) throw failure();
}
async function readVersion(runner: BackupProcessRunner, parent: AbortSignal): Promise<string> {
  const controller = new AbortController(),
    signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 5000);
  const child = own(runner("pg_dump", ["--version"], { env: cleanEnv(), signal }));
  const abort = () => stopNow(child);
  signal.addEventListener("abort", abort, { once: true });
  let output = "",
    bytes = 0;
  try {
    child.child.stdin.end();
    for await (const part of child.child.stdout) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 1024) throw failure();
      output += chunk.toString("utf8");
    }
    const exit = await untilAbort(child.exit, signal);
    signal.throwIfAborted();
    const match = /^pg_dump \(PostgreSQL\) (\d{1,2}(?:\.\d+){1,2})(?:[^\r\n]*)\r?\n?$/.exec(output);
    if (exit.code !== 0 || exit.signal !== null || !match || Number(match[1]!.split(".")[0]) < 17)
      throw failure();
    return match[1]!;
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener("abort", abort);
    await cleanup(child);
  }
}

export function createBackup(deps: {
  readonly clock: Clock;
  readonly config?: BackupConfig;
  readonly storage: () => StorageProvider;
  readonly processRunner?: BackupProcessRunner;
}) {
  const runner = deps.processRunner ?? spawnProcess;
  return {
    async run(input: {
      readonly scheduledFor: Date;
      readonly signal: AbortSignal;
      readonly previousBytes?: number;
    }): Promise<BackupSummary> {
      assertNotInTransaction("ops.backup");
      const config = deps.config;
      if (!config) throw new Error("备份任务未配置");
      if (
        !Number.isSafeInteger(config.maxBytes) ||
        config.maxBytes < 1 ||
        config.maxBytes > MAX_BYTES ||
        !Number.isFinite(input.scheduledFor.getTime()) ||
        (input.previousBytes !== undefined &&
          (!Number.isSafeInteger(input.previousBytes) ||
            input.previousBytes <= 0 ||
            input.previousBytes > MAX_BYTES))
      )
        throw failure();
      const details = connection(config.databaseUrl),
        started = performance.now(),
        date = calendarDate(input.scheduledFor),
        key = `daily/${date}.dump.age`;
      const controller = new AbortController(),
        signal = AbortSignal.any([input.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), MAX_MS),
        children: OwnedChild[] = [];
      let piping: Promise<void> | undefined,
        sourceStarted = false;
      let summary: BackupSummary | undefined, cleanupFailed: boolean;
      const abort = () => {
        for (const child of children) stopNow(child);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        const pgDumpVersion = await readVersion(runner, signal),
          storage = deps.storage();
        signal.throwIfAborted();
        const uploaded = await untilAbort(
          storage.putBackupStream({
            key,
            maxBytes: config.maxBytes,
            signal,
            body: async function* (storageSignal) {
              if (sourceStarted) throw failure();
              sourceStarted = true;
              const activeSignal = AbortSignal.any([signal, storageSignal]);
              activeSignal.throwIfAborted();
              const dump = own(
                runner("pg_dump", details.args, { env: details.env, signal: activeSignal }),
              );
              children.push(dump);
              const age = own(
                runner("age", ["-r", config.recipient], { env: cleanEnv(), signal: activeSignal }),
              );
              children.push(age);
              const stopped = () => controller.abort();
              activeSignal.addEventListener("abort", stopped, { once: true });
              for (const child of children)
                void child.exit.then((exit) => {
                  if (exit.code !== 0 || exit.signal !== null) controller.abort();
                });
              dump.child.stdin.end();
              piping = pipeline(dump.child.stdout, age.child.stdin, { signal: activeSignal });
              void piping.catch(() => controller.abort());
              try {
                for await (const part of age.child.stdout) {
                  activeSignal.throwIfAborted();
                  const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
                  // Storage公开流上界为每块1MiB；只切当前块，不聚合dump。
                  for (let offset = 0; offset < chunk.length; offset += 1024 * 1024)
                    yield chunk.subarray(offset, offset + 1024 * 1024);
                }
              } finally {
                activeSignal.removeEventListener("abort", stopped);
              }
            },
          }),
          signal,
        );
        signal.throwIfAborted();
        if (!uploaded.ok || !sourceStarted || children.length !== 2 || !piping) throw failure();
        await untilAbort(piping, signal);
        const exits = await untilAbort(Promise.all(children.map((child) => child.exit)), signal);
        signal.throwIfAborted();
        if (exits.some((exit) => exit.code !== 0 || exit.signal !== null)) throw failure();
        const head = await untilAbort(
          storage.headBackup({ key, ifMatchEtag: uploaded.value.etag, signal }),
          signal,
        );
        signal.throwIfAborted();
        if (
          !head.ok ||
          !head.value.exists ||
          head.value.etag !== uploaded.value.etag ||
          head.value.size !== uploaded.value.size ||
          (input.previousBytes !== undefined && head.value.size * 2 < input.previousBytes)
        )
          throw failure();
        if (date.endsWith("-01")) {
          signal.throwIfAborted();
          const copied = await untilAbort(
            storage.copyBackup({
              srcKey: key,
              dstKey: `monthly/${date}.dump.age`,
              ifMatchEtag: uploaded.value.etag,
              signal,
            }),
            signal,
          );
          signal.throwIfAborted();
          if (!copied.ok || copied.value.size !== head.value.size) throw failure();
        }
        const result = {
          key,
          bytes: head.value.size,
          seconds: Math.ceil((performance.now() - started) / 1000),
          pgDumpVersion,
        };
        if (!readBackupSummary(result)) throw failure();
        summary = result;
      } catch {
        throw failure();
      } finally {
        clearTimeout(timer);
        controller.abort();
        signal.removeEventListener("abort", abort);
        const results = await Promise.allSettled(children.map(cleanup));
        if (piping) await untilAbort(piping, AbortSignal.timeout(2000)).catch(() => undefined);
        cleanupFailed = results.some((result) => result.status === "rejected");
      }
      if (cleanupFailed || !summary) throw failure();
      return summary;
    },
  };
}
