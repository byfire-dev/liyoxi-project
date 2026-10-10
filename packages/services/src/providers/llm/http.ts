import { failed } from "../types.js";
import type { ProviderFailure } from "../types.js";
import { endpointUrl, LLM_LIMITS } from "./config.js";
import type { LlmEndpoint } from "./config.js";

export type LlmHttpResult =
  | { kind: "data"; value: unknown }
  | { kind: "failure"; failure: ProviderFailure; fallback: boolean };

function failure(message: string, fallback: boolean, rejected = false): LlmHttpResult {
  return {
    kind: "failure",
    failure: failed(rejected ? "rejected" : "unavailable", message),
    fallback,
  };
}

/** 底层取消可能永不完成；清理不能延长本地期限，也不能泄漏迟到拒绝。 */
function cancelWithoutWaiting(source?: { cancel(): Promise<void> } | null): void {
  try {
    void source?.cancel().catch(() => {});
  } catch {
    // 注入的 transport 也可能同步抛错；取消失败不改变已确定的业务结果。
  }
}

/** 不依赖 transport 对 signal 的配合来结束本地等待；迟到 rejection 仍被消费。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new Error("素材理解调用已取消")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function requestChat(
  endpoint: LlmEndpoint,
  payload: string,
  transport: typeof fetch,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<LlmHttpResult> {
  if (parent.aborted) return failure("素材理解调用已取消", false);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (controller.signal.aborted) return failure("素材理解调用已取消", false);
    const transfer = transport(endpointUrl(endpoint), {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
      body: payload,
    });
    void transfer.then(
      (response) => {
        if (controller.signal.aborted) cancelWithoutWaiting(response.body);
      },
      () => {},
    );
    const response = await abortable(transfer, controller.signal);
    if (!response.ok) {
      cancelWithoutWaiting(response.body);
      const canFallback =
        response.status === 408 || response.status === 429 || response.status >= 500;
      return failure("素材理解 HTTP 失败", canFallback, !canFallback);
    }
    if (!response.body) return failure("素材理解响应不完整", true);
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > LLM_LIMITS.responseBytes)
    ) {
      cancelWithoutWaiting(response.body);
      return failure("素材理解响应超限", true);
    }
    reader = response.body.getReader();
    const bytes = Buffer.alloc(LLM_LIMITS.responseBytes);
    let size = 0;
    for (;;) {
      const chunk = await abortable(reader.read(), controller.signal);
      if (chunk.done) break;
      if (chunk.value.byteLength > LLM_LIMITS.responseBytes - size)
        return failure("素材理解响应超限", true);
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    if (controller.signal.aborted) throw new Error("素材理解调用已取消");
    return {
      kind: "data",
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
    };
  } catch {
    if (parent.aborted) return failure("素材理解调用已取消", false);
    if (timedOut) return failure("素材理解调用超时", true);
    return failure("素材理解连接或响应失败", true);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    cancelWithoutWaiting(reader);
    reader?.releaseLock();
  }
}
