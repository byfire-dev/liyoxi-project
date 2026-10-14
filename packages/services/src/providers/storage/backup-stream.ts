// 备份专用协议边界；不选择业务桶、不建桶，不缓存整份 pg_dump/age 输出。
import { createHash } from "node:crypto";
import { failed, ok } from "../types.js";
import type {
  BackupCopyInput,
  BackupHead,
  BackupHeadInput,
  BackupStreamInput,
  BackupTarget,
  ProviderFailureReason,
  StorageBucket,
  StorageProvider,
} from "../types.js";
import { MAX_STREAM_BYTES } from "./streams.js";

export const BACKUP_PART_BYTES = 5 * 1024 * 1024;
export const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_MS = 2000;
type Part = { readonly partNumber: number; readonly etag: string };
export interface BackupTransport {
  begin(key: string, signal: AbortSignal): Promise<{ readonly uploadId: string }>;
  part(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ readonly etag: string }>;
  complete(input: {
    key: string;
    uploadId: string;
    parts: readonly Part[];
    signal: AbortSignal;
  }): Promise<{ readonly etag: string }>;
  abort(input: { key: string; uploadId: string; signal: AbortSignal }): Promise<void>;
  head(input: BackupHeadInput): Promise<BackupHead>;
  copy(input: BackupCopyInput): Promise<{ readonly etag: string }>;
}
export class BackupStorageError extends Error {
  constructor(readonly reason: ProviderFailureReason = "unavailable") {
    super("备份存储协议未取得可验证结果");
  }
}
export function validBackupKey(key: string): boolean {
  const match = /^(daily|monthly)\/(\d{4}-\d{2}-\d{2})\.dump\.age$/.exec(key);
  if (!match) return false;
  const at = new Date(`${match[2]}T00:00:00.000Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === match[2];
}
export function validBackupTarget(
  target: BackupTarget,
  buckets: Readonly<Record<StorageBucket, string>>,
): boolean {
  return (
    !!target &&
    typeof target.bucket === "string" &&
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.bucket) &&
    typeof target.prefix === "string" &&
    target.prefix.length <= 256 &&
    (target.prefix === "" || /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/.test(target.prefix)) &&
    !target.prefix.startsWith("incoming/") &&
    ![buckets.asset, buckets.media, buckets.pub].includes(target.bucket) &&
    (target.bucket !== buckets.secure || target.prefix.length > 0)
  );
}
export const backupObjectKey = (target: BackupTarget, key: string) => `${target.prefix}${key}`;
const etag = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{1,1024}$/.test(value);
const size = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= MAX_STREAM_BYTES;
const goodHead = (head: BackupHead): boolean =>
  head.exists
    ? size(head.size) &&
      etag(head.etag) &&
      (head.sha256 === undefined || /^[a-f0-9]{64}$/.test(head.sha256))
    : head.size === 0;
const failure = (error: unknown) =>
  failed(
    error instanceof BackupStorageError ? error.reason : "unavailable",
    "备份存储操作失败、取消或结果未知",
  );
/** 所有迟到 next/网络应答均接住；取消不允许旧源继续驱动新的 part/complete。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BackupStorageError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function boundedCleanup(work: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLEANUP_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createBackupStorage(
  transport?: BackupTransport,
): Pick<StorageProvider, "putBackupStream" | "headBackup" | "copyBackup"> {
  const run = async <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>) => {
    if (!transport) return failed("unconfigured", "未配置备份存储目标");
    if (!(signal instanceof AbortSignal) || signal.aborted)
      return failed("unavailable", "备份存储已取消");
    const controller = new AbortController(),
      onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, BACKUP_TIMEOUT_MS);
    try {
      return ok(await action(controller.signal));
    } catch (error) {
      return failure(error);
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal.removeEventListener("abort", onAbort);
    }
  };
  return {
    putBackupStream(input: BackupStreamInput) {
      if (!transport) return Promise.resolve(failed("unconfigured", "未配置备份存储目标"));
      if (!validBackupKey(input.key) || !size(input.maxBytes) || typeof input.body !== "function")
        return Promise.resolve(failed("rejected", "备份流参数不合法"));
      return run(input.signal, async (signal) => {
        let uploadId: string | undefined, iterator: AsyncIterator<Uint8Array> | undefined;
        let completed = false;
        const source = new AbortController(),
          sourceSignal = AbortSignal.any([signal, source.signal]);
        try {
          signal.throwIfAborted();
          const begun = await transport.begin(input.key, signal);
          if (!begun.uploadId || begun.uploadId.length > 2048) throw new BackupStorageError();
          uploadId = begun.uploadId;
          signal.throwIfAborted();
          iterator = input.body(sourceSignal)[Symbol.asyncIterator]();
          const hash = createHash("sha256"),
            parts: Part[] = [];
          let buffer = new Uint8Array(BACKUP_PART_BYTES),
            filled = 0,
            total = 0;
          const send = async () => {
            signal.throwIfAborted();
            const sent = await transport.part({
              key: input.key,
              uploadId: uploadId!,
              partNumber: parts.length + 1,
              body: buffer.subarray(0, filled),
              signal,
            });
            signal.throwIfAborted();
            if (!etag(sent.etag)) throw new BackupStorageError();
            parts.push({ partNumber: parts.length + 1, etag: sent.etag });
            buffer = new Uint8Array(BACKUP_PART_BYTES);
            filled = 0;
          };
          for (;;) {
            signal.throwIfAborted();
            const next = await abortable(Promise.resolve(iterator.next()), signal);
            if (next.done) break;
            const chunk = next.value;
            if (
              !(chunk instanceof Uint8Array) ||
              chunk.length === 0 ||
              chunk.length > 1024 * 1024 ||
              total + chunk.length > input.maxBytes
            )
              throw new BackupStorageError("rejected");
            total += chunk.length;
            hash.update(chunk);
            for (let offset = 0; offset < chunk.length;) {
              const length = Math.min(buffer.length - filled, chunk.length - offset);
              buffer.set(chunk.subarray(offset, offset + length), filled);
              filled += length;
              offset += length;
              if (filled === buffer.length) await send();
            }
          }
          if (total === 0) throw new BackupStorageError("rejected");
          if (filled) await send();
          signal.throwIfAborted();
          // complete 的未知结果绝不重发；失败只回收本次 uploadId，不删除可能已提交的对象。
          const result = await transport.complete({ key: input.key, uploadId, parts, signal });
          signal.throwIfAborted();
          if (!etag(result.etag)) throw new BackupStorageError();
          const head = await transport.head({ key: input.key, ifMatchEtag: result.etag, signal });
          signal.throwIfAborted();
          if (!goodHead(head) || !head.exists || head.etag !== result.etag || head.size !== total)
            throw new BackupStorageError();
          completed = true;
          return { etag: result.etag, size: total, sha256: hash.digest("hex") };
        } finally {
          source.abort();
          // 源的 finally 与自己的 multipart 均有界回收；不能杀掉忽略 signal 的任意用户 JS。
          if (iterator?.return) await boundedCleanup(() => iterator!.return!());
          if (uploadId && !completed)
            await boundedCleanup(() =>
              transport.abort({
                key: input.key,
                uploadId: uploadId!,
                signal: AbortSignal.timeout(CLEANUP_MS),
              }),
            );
        }
      });
    },
    headBackup(input: BackupHeadInput) {
      if (!transport) return Promise.resolve(failed("unconfigured", "未配置备份存储目标"));
      if (
        !validBackupKey(input.key) ||
        (input.ifMatchEtag !== undefined && !etag(input.ifMatchEtag))
      )
        return Promise.resolve(failed("rejected", "备份对象头参数不合法"));
      return run(input.signal, async (signal) => {
        const head = await transport.head({ ...input, signal });
        signal.throwIfAborted();
        if (!goodHead(head)) throw new BackupStorageError();
        if (input.ifMatchEtag !== undefined && (!head.exists || head.etag !== input.ifMatchEtag))
          throw new BackupStorageError("rejected");
        return head;
      });
    },
    copyBackup(input: BackupCopyInput) {
      if (!transport) return Promise.resolve(failed("unconfigured", "未配置备份存储目标"));
      if (
        !validBackupKey(input.srcKey) ||
        !validBackupKey(input.dstKey) ||
        input.srcKey === input.dstKey ||
        !etag(input.ifMatchEtag)
      )
        return Promise.resolve(failed("rejected", "备份复制参数不合法"));
      return run(input.signal, async (signal) => {
        const before = await transport.head({
          key: input.srcKey,
          ifMatchEtag: input.ifMatchEtag,
          signal,
        });
        if (!goodHead(before) || !before.exists || before.etag !== input.ifMatchEtag)
          throw new BackupStorageError("rejected");
        signal.throwIfAborted();
        const copied = await transport.copy({ ...input, signal });
        if (!etag(copied.etag)) throw new BackupStorageError();
        const after = await transport.head({ key: input.dstKey, ifMatchEtag: copied.etag, signal });
        signal.throwIfAborted();
        if (
          !goodHead(after) ||
          !after.exists ||
          after.etag !== copied.etag ||
          after.size !== before.size ||
          (before.sha256 !== undefined && after.sha256 !== before.sha256)
        )
          throw new BackupStorageError();
        return {
          etag: after.etag,
          size: after.size,
          ...(after.sha256 ? { sha256: after.sha256 } : {}),
        };
      });
    },
  };
}
