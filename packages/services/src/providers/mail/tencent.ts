import { z } from "zod";
import { notificationFailed, notificationOk } from "../types.js";
import type {
  MailProvider,
  NotificationFailureDetail,
  NotificationProviderResult,
} from "../types.js";
import { MAIL_CONTENT_TYPE, MAIL_HOST, signMail } from "./sign.js";

export interface TencentMailConfig {
  readonly secretId: string;
  readonly secretKey: string;
  readonly region: "ap-guangzhou" | "ap-hongkong";
  readonly fromAddress: string;
  readonly templateId: number;
}
export interface TencentMailOptions {
  readonly now: () => Date;
  /** 仅测试运输注入；生产目的地始终固定，不从FILE接受endpoint。 */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}
const configSchema = z.strictObject({
  secretId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  secretKey: z.string().regex(/^[\x21-\x7e]{1,256}$/),
  region: z.enum(["ap-guangzhou", "ap-hongkong"]),
  fromAddress: z.email().max(254),
  templateId: z.int().positive(),
});
const MAX_ATTACHMENTS = 4 * 1024 * 1024,
  MAX_REQUEST = 8 * 1024 * 1024,
  MAX_RESPONSE = 256 * 1024;
type SendResult = NotificationProviderResult<{ messageId: string }>;
const failure = (
  acceptance: NotificationFailureDetail["acceptance"],
  code: NotificationFailureDetail["code"],
  message: string,
): SendResult =>
  notificationFailed(acceptance === "unknown" ? "unavailable" : "rejected", message, {
    acceptance,
    code,
  });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const messageId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);

function payloadOf(
  config: TencentMailConfig,
  input: Parameters<MailProvider["send"]>[0],
): string | null {
  if (
    !z.email().max(254).safeParse(input.to).success ||
    typeof input.subject !== "string" ||
    !input.subject.trim() ||
    input.subject.length > 998 ||
    /[\r\n\0]/.test(input.subject) ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    /<\/?[A-Za-z][^>]*>/.test(input.text) ||
    Buffer.byteLength(input.text) > MAX_REQUEST ||
    (input.attachments !== undefined && !Array.isArray(input.attachments))
  )
    return null;
  const attachments = input.attachments ?? [];
  if (attachments.length > 10) return null;
  let size = 0;
  for (const item of attachments) {
    if (
      !item ||
      typeof item.filename !== "string" ||
      !item.filename.trim() ||
      [...item.filename].length > 255 ||
      /[?\\*|"<>:/\s]/.test(item.filename) ||
      [...item.filename].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !(item.content instanceof Uint8Array) ||
      !item.content.byteLength
    )
      return null;
    size += item.content.byteLength;
    if (size > MAX_ATTACHMENTS) return null;
  }
  const payload = JSON.stringify({
    FromEmailAddress: config.fromAddress,
    Destination: [input.to],
    Subject: input.subject,
    Template: { TemplateID: config.templateId, TemplateData: JSON.stringify({ text: input.text }) },
    ...(attachments.length
      ? {
          Attachments: attachments.map((item) => ({
            FileName: item.filename,
            Content: Buffer.from(item.content).toString("base64"),
          })),
        }
      : {}),
  });
  return Buffer.byteLength(payload) <= MAX_REQUEST ? payload : null;
}

/** 单请求最多10s，无内部重试；成功仅服务商受理，不是邮箱终端到达。 */
export function createTencentMail(
  config: TencentMailConfig,
  options: TencentMailOptions,
): { provider: MailProvider; close(): Promise<void> } {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const settings = configSchema.safeParse(config);
  if (
    !settings.success ||
    typeof options.now !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000
  )
    throw new TypeError("邮件推送配置不合法");
  const validConfig = settings.data;
  const transport = options.fetch ?? fetch;
  const controllers = new Set<AbortController>(),
    pending = new Set<Promise<SendResult>>();
  let closed = false,
    closing: Promise<void> | undefined;
  function send(input: Parameters<MailProvider["send"]>[0]): Promise<SendResult> {
    if (closed || input.signal?.aborted)
      return Promise.resolve(failure("not_accepted", "aborted", "邮件调用已取消或关闭"));
    const payload = payloadOf(validConfig, input);
    if (payload === null)
      return Promise.resolve(
        failure("not_accepted", "field_mismatch", "邮件输入不合法或超过大小限制"),
      );
    const timestamp = Math.floor(options.now().getTime() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      return Promise.resolve(failure("not_accepted", "field_mismatch", "邮件调用时刻不合法"));
    const controller = new AbortController();
    controllers.add(controller);
    let sent = false;
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const work = (async (): Promise<SendResult> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (controller.signal.aborted) return failure("not_accepted", "aborted", "邮件调用已取消");
        sent = true;
        const response = await transport(`https://${MAIL_HOST}/`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          body: payload,
          headers: {
            host: MAIL_HOST,
            "content-type": MAIL_CONTENT_TYPE,
            authorization: signMail({ ...validConfig, timestamp, payload }),
            "x-tc-action": "SendEmail",
            "x-tc-version": "2020-10-02",
            "x-tc-timestamp": String(timestamp),
            "x-tc-region": validConfig.region,
          },
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          return failure("unknown", "unknown_outcome", "邮件HTTP结果未知");
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE) return failure("unknown", "unknown_outcome", "邮件响应超限");
          chunks.push(chunk.value);
        }
        if (controller.signal.aborted) throw new Error("cancelled");
        const json: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
        );
        if (!record(json) || !record(json.Response))
          return failure("unknown", "unknown_outcome", "邮件响应格式未知");
        const result = json.Response;
        if (Object.hasOwn(result, "Error")) {
          const code = record(result.Error) ? result.Error.Code : undefined;
          if (
            typeof code === "string" &&
            /^(?:AuthFailure(?:\.|$)|InvalidParameter(?:Value)?(?:\.|$)|MissingParameter$|UnknownParameter$|UnsupportedOperation$|OperationDenied$|FailedOperation\.(?:InvalidTemplateID|WithOutPermission|NotAuthenticatedSender|IncorrectEmail|IncorrectSender)$)/.test(
              code,
            )
          )
            return failure("not_accepted", "provider_rejected", "邮件请求被服务商拒绝");
          if (code === "RequestLimitExceeded" || code === "FailedOperation.FrequencyLimit")
            return failure("not_accepted", "rate_limited", "邮件请求被限频拒绝");
          return failure("unknown", "unknown_outcome", "邮件服务商受理结果未知");
        }
        return messageId(result.MessageId)
          ? notificationOk({ messageId: result.MessageId }, result.MessageId)
          : failure("unknown", "unknown_outcome", "邮件响应缺少合法受理标识");
      } catch {
        return failure(
          sent ? "unknown" : "not_accepted",
          input.signal?.aborted ? "aborted" : "unknown_outcome",
          "邮件请求失败或取消，受理结果未确认",
        );
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        controllers.delete(controller);
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }
  return {
    provider: { status: "tencent", configured: true, send },
    close() {
      if (!closing) {
        closed = true;
        for (const controller of controllers) controller.abort();
        closing = Promise.allSettled([...pending]).then(() => undefined);
      }
      return closing;
    },
  };
}
