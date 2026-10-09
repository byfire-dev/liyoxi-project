// 10s × 1；发送是否受理不明时禁止 Provider 内重试（D6 §2.5/2.10）。
import { failed, ok } from "../types.js";
import type { ProviderResult } from "../types.js";
import { signSms, SMS_CONTENT_TYPE, SMS_HOST } from "./sign.js";

export interface TencentSmsConfig {
  readonly secretId: string;
  readonly secretKey: string;
  readonly sdkAppId: string;
  readonly region: string;
}
export interface SmsHttpOptions {
  readonly config: TencentSmsConfig;
  /** 仅显式构造测试驱动可注入，环境配置不提供 endpoint。 */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}
export type SmsHttpResult = ProviderResult<Record<string, unknown>>;
export function createSmsHttp(options: SmsHttpOptions) {
  return async (
    action: "SendSms" | "SmsPackagesStatistics",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SmsHttpResult> => {
    if (signal?.aborted) return failed("unavailable", "短信请求已取消，受理结果不明");
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 10_000);
    const payload = JSON.stringify(body);
    const timestamp = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    let complete = false;
    try {
      const response = await (options.fetch ?? fetch)(`https://${SMS_HOST}/`, {
        method: "POST",
        redirect: "error",
        body: payload,
        signal: controller.signal,
        headers: {
          Authorization: signSms({ ...options.config, timestamp, payload }),
          "Content-Type": SMS_CONTENT_TYPE,
          Host: SMS_HOST,
          "X-TC-Action": action,
          "X-TC-Version": "2021-01-11",
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Region": options.config.region,
        },
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return failed("unavailable", "短信 HTTP 返回异常，受理结果不明");
      }
      reader = response.body.getReader();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      for (;;) {
        const next = await reader.read();
        if (controller.signal.aborted) return failed("unavailable", "短信请求已取消，受理结果不明");
        if (next.done) {
          complete = true;
          break;
        }
        bytes += next.value.byteLength;
        if (bytes > 256 * 1024) return failed("unavailable", "短信响应超过允许大小，受理结果不明");
        parts.push(next.value);
      }
      const json: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!isRecord(json) || !isRecord(json["Response"]))
        return failed("unavailable", "短信响应格式异常，受理结果不明");
      return ok(json["Response"]);
    } catch {
      return failed("unavailable", "短信请求失败或超时，受理结果不明");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reader) {
        if (!complete) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }
    }
  };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 仅允许有限、非敏感的官方追踪号/错误码，拒绝回显原 message/PhoneNumber。 */
export function opaque(value: unknown, max = 64): string | undefined {
  return typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : undefined;
}
