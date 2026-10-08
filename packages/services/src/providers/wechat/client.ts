// 私有微信HTTP边界；工程预算，不是微信官方响应/时限承诺。
import { failed } from "../types.js";
import type { ProviderFailure } from "../types.js";

export const WECHAT_ORIGIN = "https://api.weixin.qq.com";
export const HTTP_TIMEOUT_MS = 4_000;
export const JSON_REQUEST_BYTES = 64 * 1024;
export const JSON_RESPONSE_BYTES = 256 * 1024;
export const QR_RESPONSE_BYTES = 2 * 1024 * 1024;
const PATHS = [
  "/sns/jscode2session",
  "/cgi-bin/stable_token",
  "/wxa/business/getuserphonenumber",
  "/cgi-bin/message/subscribe/send",
  "/wxa/getwxacodeunlimit",
  "/wxa/msg_sec_check",
  "/wxa/media_check_async",
] as const;
export type WechatPath = (typeof PATHS)[number];
export interface WechatRequest {
  path: WechatPath;
  query?: Readonly<Record<string, string>>;
  body?: Readonly<Record<string, unknown>>;
  /** 仅私有调用生命周期，不扩公共Provider协议。 */
  signal?: AbortSignal;
}
export interface WechatHttpFailure extends ProviderFailure {
  code?: number;
  status?: number;
}
export type WechatHttpOutcome =
  | {
      ok: true;
      value: { bytes: Uint8Array; json: Record<string, unknown> | null; contentType: string };
    }
  | WechatHttpFailure;
export interface WechatClient {
  request(spec: WechatRequest): Promise<WechatHttpOutcome>;
  close(): Promise<void>;
}

/** 不引用微信errmsg/异常原文；未知码不假称受理成功。 */
function failure(status?: number, code?: number, malformed = false): WechatHttpFailure {
  const knownRejection = [
    40001, 40003, 40013, 40029, 40037, 40125, 41030, 42001, 43101, 43107, 45168, 47003,
  ].includes(code ?? 0);
  const transient =
    malformed ||
    status === undefined ||
    status === 429 ||
    status >= 500 ||
    (status >= 300 && status < 400) ||
    !knownRejection;
  return {
    ...failed(transient ? "unavailable" : "rejected", "微信HTTP请求未完成"),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** 原Promise即使忽略signal也不能使拥有者永远等待；每条等待都卸载监听器。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("WECHAT_ABORTED"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
function imageType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  return undefined;
}
export function createWechatClient(
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): WechatClient {
  const timeout = deps.timeoutMs ?? HTTP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > HTTP_TIMEOUT_MS)
    throw new Error("微信HTTP预算不合格");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pending = new Map<AbortController, Promise<WechatHttpOutcome>>();
  let closed = false;
  async function perform(
    spec: WechatRequest,
    controller: AbortController,
  ): Promise<WechatHttpOutcome> {
    const signal = controller.signal;
    const externalAbort = () => controller.abort();
    spec.signal?.addEventListener("abort", externalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      complete = false;
    try {
      if (spec.signal?.aborted || closed) {
        controller.abort();
        return failure();
      }
      if (!PATHS.includes(spec.path)) return { ...failed("rejected", "微信HTTP路径不合格") };
      const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
      if (body !== undefined && Buffer.byteLength(body) > JSON_REQUEST_BYTES)
        return failed("rejected", "微信HTTP请求超出工程预算");
      const url = new URL(spec.path, WECHAT_ORIGIN);
      for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value);
      const response = await abortable(
        fetchImpl(url, {
          method: spec.path === "/sns/jscode2session" ? "GET" : "POST",
          redirect: "manual",
          signal,
          headers: {
            Accept:
              spec.path === "/wxa/getwxacodeunlimit"
                ? "image/png,image/jpeg,application/json"
                : "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
        }).then((value) => {
          if (signal.aborted) void value.body?.cancel().catch(() => {});
          return value;
        }),
        signal,
      );
      const limit =
        spec.path === "/wxa/getwxacodeunlimit" ? QR_RESPONSE_BYTES : JSON_RESPONSE_BYTES;
      const declared = response.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
        controller.abort();
        if (response.body) await abortable(response.body.cancel(), signal).catch(() => {});
        return failure(response.status, undefined, true);
      }
      if (response.status >= 300 && response.status < 400) {
        if (response.body) await abortable(response.body.cancel(), signal).catch(() => {});
        return failure(response.status);
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const next = await abortable(reader.read(), signal);
          if (next.done) {
            complete = true;
            break;
          }
          size += next.value.byteLength;
          if (size > limit) {
            controller.abort();
            return failure(response.status, undefined, true);
          }
          chunks.push(next.value);
        }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      const contentType = imageType(bytes);
      if (
        contentType &&
        response.status >= 200 &&
        response.status < 300 &&
        spec.path === "/wxa/getwxacodeunlimit"
      )
        return { ok: true, value: { bytes, json: null, contentType } };
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return failure(response.status, undefined, true);
      }
      if (!object(value)) return failure(response.status, undefined, true);
      const code = value["errcode"];
      if (code !== undefined && (!Number.isSafeInteger(code) || typeof code !== "number"))
        return failure(response.status, undefined, true);
      if (response.status < 200 || response.status >= 300 || (code !== undefined && code !== 0))
        return failure(response.status, typeof code === "number" ? code : undefined);
      if (spec.path === "/wxa/getwxacodeunlimit") return failure(response.status, undefined, true);
      return { ok: true, value: { bytes, json: value, contentType: "application/json" } };
    } catch {
      return failure();
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", externalAbort);
      if (reader) {
        if (!complete) await abortable(reader.cancel(), signal).catch(() => {});
        reader.releaseLock();
      }
    }
  }
  return {
    request(spec) {
      if (closed) return Promise.resolve(failure());
      const controller = new AbortController();
      const result = perform(spec, controller);
      pending.set(controller, result);
      void result.then(
        () => pending.delete(controller),
        () => pending.delete(controller),
      );
      return result;
    },
    async close() {
      closed = true;
      for (const controller of pending.keys()) controller.abort();
      await Promise.allSettled(pending.values());
    },
  };
}
