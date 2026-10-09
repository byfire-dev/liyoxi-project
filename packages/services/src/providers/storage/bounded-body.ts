// 只消费流，不调用将整个响应物化的 SDK helper。HEAD 确定分配大小，每块先验界限再复制。
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { failed, ok } from "../types.js";
import type { ProviderResult } from "../types.js";

export async function disposeBody(body: unknown): Promise<void> {
  if (body instanceof Readable) {
    const closed = finished(body, { cleanup: true }).catch(() => {});
    body.destroy();
    await closed;
  } else if (body instanceof ReadableStream) await body.cancel().catch(() => {});
}

export async function readBoundedBody(
  body: unknown,
  expectedBytes: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ProviderResult<Uint8Array>> {
  if (!(body instanceof Readable) && !(body instanceof ReadableStream)) {
    return failed("rejected", "对象读取未返回可消费的流");
  }
  if (signal?.aborted) {
    await disposeBody(body);
    return failed("rejected", "对象读取已取消");
  }
  const reader = body instanceof ReadableStream ? body.getReader() : undefined;
  const cancel = () => {
    if (body instanceof Readable) body.destroy();
    else void reader?.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let completed = false;
  try {
    const bytes = new Uint8Array(expectedBytes);
    let received = 0;
    // SDK 在 Node 中给 Readable；Web 分支同样逐块读取并在取消时释放 reader。
    async function* chunks(): AsyncGenerator<unknown> {
      if (body instanceof Readable) yield* body;
      else if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          yield next.value;
        }
      }
    }
    for await (const chunk of chunks()) {
      if (signal?.aborted) return failed("rejected", "对象读取已取消");
      if (!(chunk instanceof Uint8Array)) return failed("rejected", "对象流返回非字节数据");
      if (chunk.byteLength > maxBytes - received || chunk.byteLength > expectedBytes - received)
        return failed("rejected", "对象实际大小超过读取上限或对象头声明");
      bytes.set(chunk, received);
      received += chunk.byteLength;
    }
    if (signal?.aborted) return failed("rejected", "对象读取已取消");
    if (received !== expectedBytes) return failed("rejected", "对象实际大小与对象头不一致");
    completed = true;
    return ok(bytes);
  } catch {
    return signal?.aborted
      ? failed("rejected", "对象读取已取消")
      : failed("unavailable", "对象响应流读取失败");
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (body instanceof Readable) await disposeBody(body);
    else if (reader) {
      if (!completed) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
