// W228 test-only shared-scope checks and real local object IO. No business-row writes.
import { setTimeout as pause } from "node:timers/promises";
import { testDatabaseName } from "@liyoxi/db/testing/standalone";
import { createMinioStorage } from "../providers/index.js";
import type { PresignedPost } from "../providers/index.js";
import type { M1Attachment, M1SharedScope } from "./m1-types.js";
import type { AdjustableClock } from "./clock.js";
import type { FakeStorage } from "./providers/index.js";
import { assertM1LicenseTestInputs } from "./m1-license-inputs.js";

export function assertM1SharedScope(scope: M1SharedScope): void {
  if (scope.licenseTestInputs !== undefined) assertM1LicenseTestInputs(scope.licenseTestInputs);
  if (
    !/^[a-z0-9]{1,12}$/.test(scope.runId) ||
    scope.databaseName !==
      testDatabaseName("api", { session: scope.runId, worker: "0", label: "m1" }) ||
    scope.redisPrefix !== `lyx:test:${scope.runId}:0:` ||
    !/^[a-f0-9]{32}$/.test(scope.ownerToken) ||
    !Number.isFinite(Date.parse(scope.startedAt))
  )
    throw new Error("M1 attach 不是明确自有随机库能力");
}

/** implements原测试形状，但真实时间模式禁止set/advance。 */
export function createM1RealClock(): AdjustableClock {
  return {
    now: () => new Date(),
    advance() {
      throw new Error("M1 HTTP 模式禁止拨动业务时钟");
    },
    set() {
      throw new Error("M1 HTTP 模式禁止拨动业务时钟");
    },
  };
}
export async function waitM1Due(at: Date, signal?: AbortSignal): Promise<void> {
  const remaining = at.getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining > 30_000) throw new Error("M1 到期等待超过三十秒");
  const until = performance.now() + 30_000;
  while (Date.now() < at.getTime()) {
    signal?.throwIfAborted();
    if (performance.now() >= until) throw new Error("M1 到期等待未完成");
    await pause(Math.min(50, Math.max(1, at.getTime() - Date.now())), undefined, { signal });
  }
  signal?.throwIfAborted();
}

export function createM1HttpStorage(attach: M1Attachment) {
  assertM1SharedScope(attach.scope);
  const config = attach.storage;
  const allowed = ["localhost", "127.0.0.1", `lyx-mixed-${attach.scope.runId}-minio`];
  const origin = new URL(config.publicEndpoint ?? config.endpoint);
  for (const address of [new URL(config.endpoint), origin])
    if (
      address.protocol !== "http:" ||
      !allowed.includes(address.hostname) ||
      address.username ||
      address.password ||
      address.pathname !== "/" ||
      address.search ||
      address.hash
    )
      throw new Error("M1 MinIO 必须属于本轮本地隔离目标");
  if (
    config.accessKey !== "liyoxi" ||
    config.secretKey !== "lyx-local-dev" ||
    config.backup ||
    Object.keys(config.buckets).sort().join() !== "asset,media,pub,secure" ||
    Object.entries(config.buckets).some(
      ([kind, name]) => name !== `lyx-test-mixed-${attach.scope.runId}-${kind}`,
    )
  )
    throw new Error("M1 MinIO 只接受公知测试值与本轮四桶");
  const storage = createMinioStorage(config);
  const stopped = new AbortController();
  const signal = () => AbortSignal.any([stopped.signal, AbortSignal.timeout(30_000)]);
  const target = (value: string) => {
    const url = new URL(value);
    const bucket = url.pathname.split("/")[1];
    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !Object.values(config.buckets).includes(bucket ?? "")
    )
      throw new Error("M1 对象请求离开本轮 MinIO");
    return url;
  };
  return {
    storage,
    abort: () => stopped.abort(),
    close() {
      stopped.abort();
      return storage.close();
    },
    async upload(post: PresignedPost, bytes: Uint8Array): Promise<number> {
      if (bytes.length < 1 || bytes.length > 200 * 1024 * 1024 || post.expiresAt <= new Date())
        throw new Error("M1 对象直传字节或期限无效");
      const form = new FormData();
      for (const [key, value] of Object.entries(post.fields)) form.set(key, value);
      form.set("file", new Blob([Uint8Array.from(bytes)]));
      const response = await fetch(target(post.url), {
        method: "POST",
        body: form,
        redirect: "error",
        signal: signal(),
      });
      await response.body?.cancel();
      return response.status;
    },
    async readSigned(url: string): Promise<ReturnType<FakeStorage["fetch"]>> {
      const response = await fetch(target(url), { redirect: "error", signal: signal() });
      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        return { status: response.status };
      }
      if (response.status !== 200 || !response.body) throw new Error("M1 已签对象读取失败");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 200 * 1024 * 1024) throw new Error("M1 已签对象超出字节上界");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        status: 200,
        body,
        mime: response.headers.get("content-type") ?? "application/octet-stream",
        ...(response.headers.has("content-disposition")
          ? { contentDisposition: response.headers.get("content-disposition")! }
          : {}),
      };
    },
  };
}
