// 官方群机器人 text 协议；固定地址、单次请求，成功只表示明确受理。
// https://developer.work.weixin.qq.com/document/path/91770
import { notificationFailed, notificationOk } from "../types.js";
import type { NotificationProviderResult, WecomProvider } from "../types.js";

export interface WecomRobotConfig {
  readonly key: string;
}
export interface WecomRobotOptions {
  /** 仅显式装配/协议测试可注入；没有 endpoint 配置。 */
  readonly fetchImpl?: typeof fetch;
  /** 只允许缩短十秒硬上限。 */
  readonly timeoutMs?: number;
}

function unknownOutcome(): NotificationProviderResult<void> {
  return notificationFailed("unavailable", "机器人请求未取得明确受理结果", {
    acceptance: "unknown",
    code: "unknown_outcome",
  });
}
function notStarted(): NotificationProviderResult<void> {
  return notificationFailed("rejected", "机器人调用开始前已取消或关闭", {
    acceptance: "not_accepted",
    code: "aborted",
  });
}
/** 同时接住迟到结果；不靠外部 Promise 是否遵守 signal 来限制本次等待。 */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("机器人调用已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("机器人调用失败"));
      },
    );
    if (signal.aborted) abort();
  });
}

export function createWecomRobot(config: WecomRobotConfig, options: WecomRobotOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    typeof config?.key !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(config.key) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000
  )
    throw new TypeError("企业微信机器人配置不合法");
  const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${config.key}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<NotificationProviderResult<void>>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const sendRobotMessage: WecomProvider["sendRobotMessage"] = (input) => {
    if (closed || input.signal?.aborted) return Promise.resolve(notStarted());
    if (
      typeof input.title !== "string" ||
      typeof input.content !== "string" ||
      typeof input.mentionAll !== "boolean" ||
      !input.title.trim() ||
      !input.content.trim() ||
      input.title.length + input.content.length + 1 > 2048 ||
      Buffer.byteLength(`${input.title}\n${input.content}`, "utf8") > 2048
    )
      return Promise.resolve(
        notificationFailed("rejected", "机器人文本格式不合法或超过允许大小", {
          acceptance: "not_accepted",
          code: "field_mismatch",
        }),
      );
    const controller = new AbortController();
    controllers.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    const abort = () => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const work = (async (): Promise<NotificationProviderResult<void>> => {
      try {
        if (controller.signal.aborted) return notStarted();
        const request = fetchImpl(url, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            msgtype: "text",
            text: {
              content: `${input.title}\n${input.content}`,
              ...(input.mentionAll ? { mentioned_list: ["@all"] } : {}),
            },
          }),
          signal: controller.signal,
        });
        // 注入的 transport 若迟到，仍回收此请求所属的响应体。
        void request.then(
          (response) => {
            if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
          },
          () => undefined,
        );
        const response = await untilAbort(request, controller.signal);
        if (!response.ok || !response.body) {
          void response.body?.cancel().catch(() => undefined);
          return unknownOutcome();
        }
        reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const next = await untilAbort(reader.read(), controller.signal);
          if (controller.signal.aborted) return unknownOutcome();
          if (next.done) {
            complete = true;
            break;
          }
          bytes += next.value.byteLength;
          if (bytes > 64 * 1024) return unknownOutcome();
          parts.push(next.value);
        }
        const raw: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (
          typeof raw !== "object" ||
          raw === null ||
          Array.isArray(raw) ||
          !("errcode" in raw) ||
          !Number.isSafeInteger(raw.errcode)
        )
          return unknownOutcome();
        if (controller.signal.aborted) return unknownOutcome();
        return raw.errcode === 0
          ? notificationOk(undefined)
          : notificationFailed("rejected", "机器人服务明确拒绝本次消息", {
              acceptance: "not_accepted",
              code: "provider_rejected",
            });
      } catch {
        // 不回显 URL、key、原始异常或厂商 errmsg；不自动重发未知结果。
        return unknownOutcome();
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        if (!complete) abort();
        reader?.releaseLock();
        controllers.delete(controller);
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  return {
    sendRobotMessage,
    close(): Promise<void> {
      closed = true;
      for (const controller of controllers) controller.abort();
      return (closing ??= Promise.allSettled([...pending]).then(() => undefined));
    },
  };
}
