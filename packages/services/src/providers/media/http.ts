import { failed, ok } from "../types.js";
import type { ProviderResult, StorageBucket } from "../types.js";
import { cosAuthorization, cosEncode } from "../storage/cos-signature.js";
import type { CosKey } from "../storage/cos-signature.js";

export interface CiConfig {
  readonly region: string;
  readonly buckets: Readonly<Record<StorageBucket, string>>;
  readonly worker: CosKey;
  readonly callback: { readonly origin: string; readonly key: string };
}
export function createCiHttp(
  config: CiConfig,
  options: { now: () => Date; fetchImpl?: typeof fetch },
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  async function exchange(input: {
    bucket: StorageBucket;
    cos?: boolean;
    method: "GET" | "POST" | "PUT";
    path: string;
    query?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<string>> {
    if (closed || input.signal?.aborted) return failed("unavailable", "CI请求已取消");
    const host = `${config.buckets[input.bucket]}.${input.cos ? "cos" : "ci"}.${config.region}.myqcloud.com`;
    const query = input.query ?? {};
    const url = `https://${host}${input.path}${
      Object.keys(query).length
        ? `?${Object.entries(query)
            .map(([k, v]) => `${cosEncode(k)}=${cosEncode(v)}`)
            .join("&")}`
        : ""
    }`;
    const headers: Record<string, string> = { host };
    if (input.body !== undefined) headers["content-type"] = "application/xml";
    const start = Math.floor(options.now().getTime() / 1000);
    headers.authorization = cosAuthorization({
      key: config.worker,
      method: input.method,
      pathname: input.path,
      headers,
      query,
      start,
      end: start + 600,
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    controllers.add(controller);
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelBody = () => {
      void reader?.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancelBody, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: input.method,
        headers,
        body: input.body,
        signal: controller.signal,
        redirect: "error",
      });
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2 * 1024 * 1024)) {
        await response.body?.cancel();
        return failed("rejected", "CI应答超出界限");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      reader = response.body?.getReader();
      if (controller.signal.aborted) {
        await reader?.cancel();
        return failed("unavailable", "CI请求已取消");
      }
      if (reader)
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > 2 * 1024 * 1024) {
            await reader.cancel();
            return failed("rejected", "CI应答超出界限");
          }
          chunks.push(item.value);
        }
      if (controller.signal.aborted) return failed("unavailable", "CI请求已取消");
      if (response.status < 200 || response.status >= 300)
        return failed(
          response.status >= 500 || response.status === 429 ? "unavailable" : "rejected",
          "CI拒绝请求或暂不可用",
        );
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return failed("unavailable", "CI请求中断或应答无效");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancelBody);
      input.signal?.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      controllers.delete(controller);
    }
  }
  function request(input: Parameters<typeof exchange>[0]) {
    const operation = exchange(input);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  async function close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...pending]);
  }
  return { request, close };
}
