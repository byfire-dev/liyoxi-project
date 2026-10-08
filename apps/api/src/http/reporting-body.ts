import type { RouteMiddlewareFactory } from "../routing/types.js";

const LIMITS: Readonly<Record<string, number>> = {
  "m.analyticsEvent.batchCreate": 64 * 1024,
  "m.clientError.create": 200 * 1024,
  "admin.clientError.create": 200 * 1024,
};

/** 只读一次真实流；Content-Length 不参与放行，有界 bytes 缓存供 Hono 的正式解析器复用。 */
export const reportingBody: RouteMiddlewareFactory = (route) => {
  if (!Object.hasOwn(LIMITS, route.operationId)) return null;
  const limit = LIMITS[route.operationId]!;
  return async (c, next) => {
    const reader = c.req.raw.body?.getReader();
    if (!reader) {
      c.req.bodyCache.arrayBuffer = Promise.resolve(new ArrayBuffer(0)) as unknown as ArrayBuffer;
      await next();
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let aborted = c.req.raw.signal.aborted;
    const cancel = () => {
      aborted = true;
      void reader.cancel().catch(() => undefined);
    };
    c.req.raw.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (aborted) await reader.cancel();
      while (!aborted) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return c.text("Payload Too Large", 413);
        }
        chunks.push(part.value);
      }
      if (aborted) return c.text("Request Aborted", 400);
    } finally {
      c.req.raw.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Hono 4.13.9 的公开 BodyCache 声明是值，但真实 cachedBody 调用 .then；缓存必须是 settled Promise。
    // 此窄适配只含已受限 bytes，不保留原流/clone，也不改变业务输入。
    c.req.bodyCache.arrayBuffer = Promise.resolve(bytes.buffer) as unknown as ArrayBuffer;
    await next();
  };
};
