import { failed, ok } from "../types.js";
import type { AsrSubmissionFailure, ProviderSuccess } from "../types.js";
import { ASR_CONTENT_TYPE, ASR_HOST, signAsr } from "./sign.js";
import { parseResponse } from "./parse.js";

export interface TencentAsrConfig {
  secretId: string;
  secretKey: string;
}
export interface TencentAsrOptions {
  now: () => Date;
  /** 私有协议测试可转发 loopback；生产请求目标仍由本驱动固定。 */
  fetch?: typeof fetch;
  /** 单请求最多10秒；不含业务轮询、重试或任务期限。 */
  timeoutMs?: number;
}
export function asrFailure(
  reason: AsrSubmissionFailure["reason"],
  message: string,
  acceptance: AsrSubmissionFailure["acceptance"],
  code: AsrSubmissionFailure["code"],
): AsrSubmissionFailure {
  return { ...failed(reason, message), acceptance, code };
}
type HttpResult = ProviderSuccess<Record<string, unknown>> | AsrSubmissionFailure;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function createAsrHttp(config: TencentAsrConfig, options: TencentAsrOptions) {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (
    typeof config.secretId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.secretId) ||
    typeof config.secretKey !== "string" ||
    !config.secretKey ||
    config.secretKey.length > 256 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10000
  )
    throw new TypeError("录音转写配置不合法");
  const transport = options.fetch ?? fetch;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<HttpResult>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function request(
    action: "CreateRecTask" | "DescribeTaskStatus",
    payload: string,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    if (closed)
      return Promise.resolve(
        asrFailure("unavailable", "录音转写驱动已关闭", "not_accepted", "closed"),
      );
    if (signal?.aborted)
      return Promise.resolve(
        asrFailure("rejected", "录音转写调用已取消", "not_accepted", "aborted"),
      );
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    let sent = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const work = (async (): Promise<HttpResult> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (controller.signal.aborted)
          return asrFailure("rejected", "录音转写调用已取消", "not_accepted", "aborted");
        const timestamp = Math.floor(options.now().getTime() / 1000);
        if (!Number.isSafeInteger(timestamp) || timestamp < 0)
          return asrFailure("rejected", "录音转写调用时间不合法", "not_accepted", "invalid_input");
        const authorization = signAsr({ ...config, timestamp, payload });
        sent = true;
        const response = await transport(`https://${ASR_HOST}/`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          body: payload,
          headers: {
            host: ASR_HOST,
            "content-type": ASR_CONTENT_TYPE,
            authorization,
            "x-tc-action": action,
            "x-tc-version": "2019-06-14",
            "x-tc-timestamp": String(timestamp),
          },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return asrFailure("unavailable", "录音转写 HTTP 失败", "unknown", "http_error");
        }
        if (!response.body)
          return asrFailure("unavailable", "录音转写响应不完整", "unknown", "invalid_response");
        reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES)
            return asrFailure("unavailable", "录音转写响应超限", "unknown", "invalid_response");
          parts.push(chunk.value);
        }
        if (controller.signal.aborted) throw new Error("录音转写调用已取消");
        const bytes = Buffer.concat(parts, size);
        const responseBody = parseResponse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!responseBody)
          return asrFailure("unavailable", "录音转写响应不完整", "unknown", "invalid_response");
        return ok(responseBody);
      } catch {
        const acceptance = sent ? "unknown" : "not_accepted";
        if (timedOut) return asrFailure("unavailable", "录音转写调用超时", acceptance, "timeout");
        if (closed) return asrFailure("unavailable", "录音转写驱动已关闭", acceptance, "closed");
        if (signal?.aborted)
          return asrFailure("unavailable", "录音转写调用已取消", acceptance, "aborted");
        if (reader)
          return asrFailure("unavailable", "录音转写响应不完整", acceptance, "invalid_response");
        return asrFailure("unavailable", "录音转写连接失败", acceptance, "transport");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        controllers.delete(controller);
      }
    })();
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  return {
    request,
    close(): Promise<void> {
      closed = true;
      for (const controller of controllers) controller.abort();
      closing ??= Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}
