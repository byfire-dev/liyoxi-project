// W228: version-bound HTTP only. No in-process request or business-service fallback.
import { setTimeout as pause } from "node:timers/promises";
import type { M1Support } from "@liyoxi/services/testing";
import type { M1Api, M1RequestInit } from "./in-process.js";

export async function waitM1RealTime(at: Date, signal?: AbortSignal): Promise<void> {
  const target = at.getTime();
  if (!Number.isFinite(target) || target - Date.now() > 30_000)
    throw new Error("M1 真实等待超出三十秒边界");
  const deadline = performance.now() + 30_000;
  while (Date.now() < target) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("M1 真实等待未到期");
    await pause(Math.min(50, Math.max(1, target - Date.now())), undefined, { signal });
  }
  signal?.throwIfAborted();
}
interface HttpOptions {
  readonly origin: string;
  readonly version: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}
/** Kept independent of support construction so transport guards need no database. */
export async function createM1HttpTransport(options: HttpOptions) {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(options.version)
  )
    throw new Error("M1 HTTP 仅接受显式本轮本地服务与构建号");
  const fetch = options.fetch ?? globalThis.fetch;
  const signal = (request?: AbortSignal | null) =>
    AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(options.signal ? [options.signal] : []),
      ...(request ? [request] : []),
    ]);
  async function version() {
    const response = await fetch(new URL("/health", origin), {
      redirect: "error",
      signal: signal(),
    });
    if (![200, 503].includes(response.status) || !response.body) {
      await response.body?.cancel();
      throw new Error("M1 HTTP 构建身份不可核验");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 64 * 1024) throw new Error("M1 HTTP 探活响应过大");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !body ||
      typeof body !== "object" ||
      !("version" in body) ||
      body.version !== options.version
    )
      throw new Error("M1 HTTP 服务版本与本轮目标不一致");
  }
  await version();
  const ready = await fetch(new URL("/readyz", origin), { redirect: "error", signal: signal() });
  await ready.body?.cancel();
  if (ready.status !== 200) throw new Error("M1 HTTP 服务尚未就绪");
  const observedReads: string[] = [];
  return {
    observedReads,
    waitUntil: (at: Date) => waitM1RealTime(at, options.signal),
    waitForNextMfaStep: () =>
      waitM1RealTime(new Date((Math.floor(Date.now() / 30_000) + 1) * 30_000), options.signal),
    async request(path: string, init: M1RequestInit = {}) {
      if (!path.startsWith("/api/v1/") || path.includes("#") || path.includes("\\"))
        throw new Error("M1 HTTP 只发送正式 API 路径");
      const target = new URL(path, origin);
      if (target.origin !== origin.origin || !target.pathname.startsWith("/api/v1/"))
        throw new Error("M1 HTTP 请求离开本轮服务");
      await version();
      const { json, headers, peer: ignored, signal: callerSignal, ...rest } = init;
      void ignored; // TCP peer comes from the real socket, never the caller's fixture field.
      const requestHeaders = new Headers(headers);
      const admin = path.startsWith("/api/v1/admin/");
      if (!requestHeaders.has("host"))
        requestHeaders.set("host", admin ? "admin.localhost" : "api.localhost");
      if (json !== undefined && !requestHeaders.has("content-type"))
        requestHeaders.set("content-type", "application/json");
      // Map only the known logical pair; malformed/foreign origins retain their original value.
      if (
        admin &&
        requestHeaders.get("host") === "admin.localhost" &&
        requestHeaders.get("origin") === "http://admin.localhost"
      )
        requestHeaders.set("origin", origin.origin);
      // Node fetch sends the physical target's Host regardless of a caller-supplied header.
      requestHeaders.set("host", origin.host);
      const response = await fetch(target, {
        ...rest,
        redirect: "error",
        signal: signal(callerSignal),
        headers: requestHeaders,
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      });
      if (response.status >= 500 || response.status === 404) {
        await response.body?.cancel();
        throw new Error(`M1 HTTP 正式接口不可用：${response.status}`);
      }
      if (
        (init.method ?? "GET").toUpperCase() === "GET" &&
        response.ok &&
        !observedReads.includes(path)
      )
        observedReads.push(path);
      return response;
    },
  };
}
export async function createM1HttpApi(
  options: HttpOptions & { readonly support: M1Support },
): Promise<M1Api & { readonly observedReads: readonly string[] }> {
  return { ...(await createM1HttpTransport(options)), support: options.support };
}
