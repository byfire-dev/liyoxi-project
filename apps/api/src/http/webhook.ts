// hooks 的私有适配：签名槽位只准备；IP限流后读原文并验签，早于 OpenAPI 解析。
import { createIdentityContext, isAppError } from "@liyoxi/services";
import type { security } from "@liyoxi/services";
type PreparedWebhook = security.PreparedWebhook;
type WebhookError = security.WebhookError;
type WebhookReply = security.WebhookReply;
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import type { RouteMiddlewareFactory } from "../routing/types.js";
import { RateLimited } from "./errors.js";
import { rateLimit } from "./rate-limit.js";
import type { RateLimitOptions } from "./rate-limit.js";

interface HookRequest {
  readonly provider: string;
  readonly operationId: string;
  prepared?: PreparedWebhook;
}
const requests = new WeakMap<Context<ApiEnv>, HookRequest>();
const respond = (reply: WebhookReply) => {
  const headers = new Headers(reply.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(reply.body, { status: reply.status, headers });
};
const failure = (
  c: Context<ApiEnv>,
  error: WebhookError,
  status?: number,
  details?: Readonly<Record<string, unknown>>,
) => {
  const input = requests.get(c)!;
  try {
    const reply = c.var.runtime.webhooks.reject(input.provider, error, details);
    c.res = respond({ ...reply, ...(status === undefined ? {} : { status }) });
  } catch (error) {
    c.res = new Response("failure", {
      status:
        status ?? (isAppError(error) && error.error === "WEBHOOK_SOURCE_DISABLED" ? 404 : 500),
      headers: { "Cache-Control": "no-store" },
    });
  }
};
export const webhookPreparation: RouteMiddlewareFactory = (route) => async (c, next) => {
  const path = route.path.split("/");
  requests.set(c, {
    provider: path[path.indexOf("hooks") + 1] ?? "",
    operationId: route.operationId,
  });
  await next();
};

async function rawBody(c: Context<ApiEnv>): Promise<Uint8Array<ArrayBuffer> | null> {
  const original = c.req.raw;
  const reader = original.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (reader)
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 1_048_576) {
          await reader.cancel();
          return null;
        }
        chunks.push(part.value);
      }
  } finally {
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // 仅替换已消费的流为同一串字节；不解析、不序列化、不修改签名原文。
  c.req.raw = new Request(original.url, {
    method: original.method,
    headers: original.headers,
    signal: original.signal,
    ...(original.method === "GET" || original.method === "HEAD" ? {} : { body: bytes }),
  });
  return bytes;
}

export const webhookRateLimit =
  (options: RateLimitOptions = {}): RouteMiddlewareFactory =>
  (route, runtime) => {
    const limit = rateLimit(options)(route, runtime)!;
    return async (c, next) => {
      try {
        await limit(c, async () => {
          const input = requests.get(c);
          // 显式测试替身覆盖 signature 时不接真实框架；生产签名工厂总会准备本请求。
          if (!input) {
            await next();
            return;
          }
          const bytes = await rawBody(c);
          if (!bytes) {
            failure(c, "WEBHOOK_PAYLOAD_INVALID", 413);
            return;
          }
          const receipt = await runtime.webhooks.prepare(input.provider, {
            rawBody: bytes,
            headers: c.req.header(),
            method: c.req.method,
            operationId: input.operationId,
            query: c.req.query(),
          });
          if (receipt.kind === "reply") {
            c.res = respond(receipt);
            return;
          }
          input.prepared = receipt;
          await next();
          // Hono 在 downstream 边界捕获校验错误，按本来源协议替换通用信封。
          if (c.error) failure(c, "WEBHOOK_PAYLOAD_INVALID");
        });
      } catch (error) {
        if (error instanceof RateLimited) {
          failure(c, "RATE_LIMITED", 429, { retryAfterSec: error.retryAfterSec });
          c.res.headers.set("Retry-After", String(error.retryAfterSec));
        } else
          failure(
            c,
            isAppError(error) && error.error === "WEBHOOK_SOURCE_DISABLED"
              ? "WEBHOOK_SOURCE_DISABLED"
              : "WEBHOOK_PAYLOAD_INVALID",
          );
      }
    };
  };
export const webhookNatural: RouteMiddlewareFactory = () => async (_c, next) => {
  await next();
};

/** 后继 hook handler 只调用本薄壳，不再读 JSON 或创建客户端幂等记录。 */
export async function receiveWebhook(c: Context<ApiEnv>): Promise<Response> {
  const input = requests.get(c);
  if (!input?.prepared) throw new TypeError("回调处理器缺少本请求验签结果");
  return respond(
    await c.var.runtime.webhooks.accept(
      input.prepared,
      createIdentityContext({
        actor: { type: "system", job: "security.webhook_receive" },
        requestId: c.var.requestId,
      }),
    ),
  );
}
