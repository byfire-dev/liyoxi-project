import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { ObjectRef, ProviderResult, StorageProvider } from "../types.js";
import { failed, ok } from "../types.js";
export interface MediaWorkSession {
  readonly path: (name: "source.mp4" | "stamped.mp4" | "poster.jpg" | "watermark.png") => string;
  download(
    input: ObjectRef & { size: number; etag: string },
  ): Promise<ProviderResult<{ size: number; sha256: string }>>;
  publish(input: {
    name: "stamped.mp4" | "source.mp4" | "poster.jpg" | "watermark.png";
    dst: ObjectRef;
    contentIdentity: string;
    expectedSha256?: string;
    expectedSize?: number;
  }): Promise<ProviderResult<{ size: number; sha256: string; etag: string }>>;
}
export interface MediaWorkspace {
  run<T>(
    job: { id: string; attemptNo: number },
    signal: AbortSignal,
    action: (work: MediaWorkSession) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
/** Only this Provider owns host filesystem paths; domain sees relative job paths. */
export function createMediaWorkspace(options: {
  workDir: string;
  storage: StorageProvider;
  beforeCall: () => void;
}): MediaWorkspace {
  if (!isAbsolute(options.workDir) || options.workDir === "/" || options.workDir.includes("\0"))
    throw new TypeError("媒体工作目录不合格");
  const active = new Set<AbortController>(),
    pending = new Set<Promise<unknown>>();
  let closed = false;
  return {
    run<T>(
      job: { id: string; attemptNo: number },
      caller: AbortSignal,
      action: (work: MediaWorkSession) => Promise<T>,
    ) {
      options.beforeCall();
      if (
        closed ||
        caller.aborted ||
        !/^[0-9a-f-]{36}$/.test(job.id) ||
        !Number.isSafeInteger(job.attemptNo) ||
        job.attemptNo < 1
      )
        return Promise.reject(new Error("媒体工作会话不可用"));
      const controller = new AbortController(),
        abort = () => controller.abort();
      caller.addEventListener("abort", abort, { once: true });
      active.add(controller);
      if (caller.aborted) abort();
      const run = async () => {
        await mkdir(options.workDir, { recursive: true });
        const root = await realpath(options.workDir);
        if (root !== options.workDir || !(await lstat(root)).isDirectory())
          throw new Error("媒体工作目录非可信目录");
        const directory = await mkdtemp(join(root, `${job.id}-${job.attemptNo}-`));
        const relative = basename(directory);
        const path = (name: "source.mp4" | "stamped.mp4" | "poster.jpg" | "watermark.png") =>
          `${relative}/${name}`;
        const regular = async (
          name: "source.mp4" | "stamped.mp4" | "poster.jpg" | "watermark.png",
        ) => {
          const file = join(directory, name);
          if ((await realpath(file)) !== file || !(await lstat(file)).isFile())
            throw new Error("媒体产物不是真实普通文件");
          return file;
        };
        const fileSource = (file: string) =>
          async function* (signal: AbortSignal) {
            if ((await realpath(directory)) !== directory) throw new Error("媒体工作目录已改变");
            const expected = await lstat(file);
            if (!expected.isFile() || (await realpath(file)) !== file)
              throw new Error("媒体产物不是真实普通文件");
            const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const actual = await handle.stat();
              if (
                !actual.isFile() ||
                actual.dev !== expected.dev ||
                actual.ino !== expected.ino ||
                (await realpath(directory)) !== directory ||
                (await realpath(file)) !== file
              )
                throw new Error("媒体产物在打开时改变");
              const chunk = Buffer.alloc(64 * 1024);
              while (true) {
                if (signal.aborted) throw new Error("媒体文件流已取消");
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
                if (!bytesRead) return;
                yield new Uint8Array(chunk.subarray(0, bytesRead));
              }
            } finally {
              await handle.close();
            }
          };
        try {
          return await action({
            path,
            download: async (input) => {
              options.beforeCall();
              if ((await realpath(directory)) !== directory) throw new Error("媒体工作目录已改变");
              const handle = await open(
                join(directory, "source.mp4"),
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              );
              try {
                if (!(await handle.stat()).isFile() || (await realpath(directory)) !== directory)
                  throw new Error("媒体下载路径在打开时改变");
                return await options.storage.readTo({
                  ...input,
                  expectedSize: input.size,
                  maxBytes: input.size,
                  ifMatchEtag: input.etag,
                  signal: controller.signal,
                  sink: async (bytes) => {
                    if (controller.signal.aborted) throw new Error("媒体下载已取消");
                    let offset = 0;
                    while (offset < bytes.length) {
                      const written = await handle.write(
                        bytes,
                        offset,
                        bytes.length - offset,
                        null,
                      );
                      if (!written.bytesWritten) throw new Error("媒体下载写入未进展");
                      offset += written.bytesWritten;
                    }
                  },
                });
              } finally {
                await handle.close();
              }
            },
            publish: async (input) => {
              options.beforeCall();
              const file = await regular(input.name),
                stat = await lstat(file),
                source = fileSource(file);
              const hash = createHash("sha256");
              for await (const chunk of source(controller.signal)) hash.update(chunk);
              const sha256 = hash.digest("hex");
              if (
                (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256) ||
                (input.expectedSize !== undefined && input.expectedSize !== stat.size)
              )
                return failed("rejected", "已校验媒体产物在发布前改变");
              const result = await options.storage.putStream({
                ...input.dst,
                body: source,
                size: stat.size,
                sha256,
                contentIdentity: input.contentIdentity,
                contentType:
                  input.name === "poster.jpg"
                    ? "image/jpeg"
                    : input.name === "watermark.png"
                      ? "image/png"
                      : "video/mp4",
                ifAbsent: true,
                signal: controller.signal,
              });
              if (!result.ok) return result;
              const head = await options.storage.head({ ...input.dst, signal: controller.signal });
              if (
                !head.ok ||
                !head.value.exists ||
                head.value.size !== stat.size ||
                head.value.etag !== result.value.etag
              )
                return failed("rejected", "媒体产物写后头信息不一致");
              return ok({ ...result.value, sha256 });
            },
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      };
      const promise = run();
      pending.add(promise);
      return promise.finally(() => {
        caller.removeEventListener("abort", abort);
        active.delete(controller);
        pending.delete(promise);
      });
    },
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
