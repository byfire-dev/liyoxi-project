import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleProviders } from "../kernel/index.js";
import type { AssembleProvidersOptions } from "../kernel/index.js";
import { withBeforeCall } from "../providers/types.js";
import { createAsrWebhookSource } from "../security/index.js";
import type { WebhookRequest } from "../security/index.js";

type TencentAsrOptions = Omit<NonNullable<AssembleProvidersOptions["asr"]>, "registerClose">;

// 仅经既有 kernel 公口组装真实腾讯驱动，关闭函数由真实工厂登记。
function createTencentAsr(
  config: NonNullable<NonNullable<AssembleProvidersOptions["settings"]>["asr"]>,
  options: TencentAsrOptions,
) {
  let close: (() => Promise<void>) | undefined;
  const providers = assembleProviders({
    appEnv: "prod",
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: { asr: config },
    asr: {
      ...options,
      registerClose(registered) {
        close = registered;
      },
    },
  });
  if (!close) throw new Error("真实 ASR 工厂未登记关闭函数");
  return { provider: providers.asr, close };
}

// 公开虚构配置与本地 HTTP；不连接腾讯或 CallbackUrl，不伪造 DB wake。
const config = { secretId: "AKIDEXAMPLE", secretKey: "SECRETKEYEXAMPLE" };
const now = () => new Date("2019-02-25T16:17:45.000Z");
const url = "https://example.invalid/audio.m4a?signature=synthetic";
const callback = {
  origin: "https://callbacks.example.com",
  key: "0123456789abcdef0123456789abcdef",
};
const mediaJobId = "01960000-0000-7000-8000-000000000001";
const callbackUrl = `${callback.origin}/api/v1/hooks/asr/media-jobs/${mediaJobId}?sig=Te8AxwzKLiZJsOeVld_9zXls7UG5pdDRXsXTPf-vPuA`;
const submitted = { Response: { RequestId: "public-submit", Data: { TaskId: 1234 } } };
const drivers = new Set<ReturnType<typeof createTencentAsr>>();
const servers = new Set<Server>();
type Call = { body: string; headers: IncomingHttpHeaders };
async function local(
  reply: (call: Call, response: ServerResponse) => void = (_call, response) => {
    response.end(JSON.stringify(submitted));
  },
) {
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    const call = { body: Buffer.concat(parts).toString("utf8"), headers: request.headers };
    calls.push(call);
    reply(call, response);
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地协议服务未就绪");
  const authority = `127.0.0.1:${address.port}`;
  const forwarding: typeof fetch = (target, init) => {
    expect(target).toBe("https://asr.tencentcloudapi.com/");
    expect(new Headers(init?.headers).get("host")).toBe("asr.tencentcloudapi.com");
    expect(init?.redirect).toBe("error");
    return fetch(`http://${authority}/`, init);
  };
  return { fetch: forwarding, calls, authority };
}
function driver(options: Omit<TencentAsrOptions, "now">) {
  const owned = createTencentAsr(config, { ...options, now });
  drivers.add(owned);
  return owned;
}
function request(destination: string, body = "requestId=1234"): WebhookRequest & { now: Date } {
  const parsed = new URL(destination);
  return {
    rawBody: Buffer.from(body),
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    method: "POST",
    operationId: "hooks.asr.mediaJob.wake",
    params: { mediaJobId: parsed.pathname.split("/").at(-1)! },
    query: Object.fromEntries(parsed.searchParams),
    now: now(),
  };
}
function receiver(key = callback.key) {
  const wake = vi.fn(async () => "processed" as const);
  return { wake, source: createAsrWebhookSource({ key, configured: () => true, wake }) };
}
// 独立重建公共 TC3 规范，不导入被测 signAsr 或 callback helper。
function authorization(payload: string) {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const canonical = [
    "POST",
    "/",
    "",
    "content-type:application/json; charset=utf-8\nhost:asr.tencentcloudapi.com\n",
    "content-type;host",
    sha(payload),
  ].join("\n");
  const scope = "2019-02-25/asr/tc3_request";
  const signingKey = hmac(hmac(hmac(`TC3${config.secretKey}`, "2019-02-25"), "asr"), "tc3_request");
  const signature = hmac(
    signingKey,
    `TC3-HMAC-SHA256\n1551111465\n${scope}\n${sha(canonical)}`,
  ).toString("hex");
  return `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
}
afterEach(async () => {
  await Promise.all([...drivers].map((owned) => owned.close()));
  drivers.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  vi.useRealTimers();
});

describe("ASR 可选回调发送与真实验签公口组合", () => {
  it("省略时原五字段JSON顺序与TC3逐字保持，显式undefined同义", async () => {
    const http = await local();
    const owned = driver(http);
    await owned.provider.submit({ url });
    await owned.provider.submit({ url, callback: undefined });
    const body = `{"EngineModelType":"16k_zh","ChannelNum":1,"ResTextFormat":3,"SourceType":0,"Url":${JSON.stringify(url)}}`;
    expect(http.calls).toHaveLength(2);
    expect(authorization(body)).toContain(
      "Signature=31620509dabd4e4e9a60a40bdbfa1958315968efb8849367d187f2133043d774",
    );
    for (const call of http.calls) {
      expect(call.body).toBe(body);
      expect(call.headers.authorization).toBe(authorization(body));
      expect(call.headers["x-tc-action"]).toBe("CreateRecTask");
      expect(call.headers["x-tc-version"]).toBe("2019-06-14");
      expect(call.headers["x-tc-timestamp"]).toBe("1551111465");
      expect(call.headers.host).toBe(http.authority);
    }
  });

  it("配齐只在末尾追加CallbackUrl并由原TC3签名，真实verify仅投影TaskId", async () => {
    const http = await local();
    const owned = driver({ ...http, callback });
    expect(await owned.provider.submit({ url, callback: { mediaJobId } })).toEqual({
      ok: true,
      value: { taskId: "1234", requestId: "public-submit" },
    });
    const body = `{"EngineModelType":"16k_zh","ChannelNum":1,"ResTextFormat":3,"SourceType":0,"Url":${JSON.stringify(url)},"CallbackUrl":${JSON.stringify(callbackUrl)}}`;
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.body).toBe(body);
    expect(http.calls[0]!.headers.authorization).toBe(authorization(body));
    expect(http.calls[0]!.headers.authorization).toContain(
      "Signature=3e04d3fae735aa46d2374f947d67468ee54bd2fd309900e34b00924fd89f2098",
    );
    const { source, wake } = receiver();
    const verified = await source.verify(
      request(
        callbackUrl,
        "requestId=18446744073709551615&text=fictional-transcript&code=999&url=https%3A%2F%2Fprivate.invalid",
      ),
    );
    expect(verified).toEqual({
      kind: "event",
      event: {
        eventId: `${mediaJobId}:18446744073709551615`,
        eventType: "asr_callback",
        data: { mediaJobId, externalJobId: "18446744073709551615" },
      },
    });
    if (verified.kind !== "event") throw new Error("公开协议向量未通过验签");
    expect(source.payload(verified.event)).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    expect(JSON.stringify(verified)).not.toContain("fictional-transcript");
    expect(source.reply(true).body).toBe('{"code":0,"message":"success"}');
  });

  it.each(["job", "key", "sig"] as const)("篡改%s被真实receiver拒绝且零wake", async (kind) => {
    const parsed = new URL(callbackUrl);
    if (kind === "job") parsed.pathname = parsed.pathname.replace(/1$/, "2");
    if (kind === "sig") parsed.searchParams.set("sig", "A".repeat(43));
    const { source, wake } = receiver(kind === "key" ? "b".repeat(32) : callback.key);
    expect(await source.verify(request(parsed.href))).toEqual({
      kind: "error",
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it.each(["context-only", "config-only"] as const)("半配%s在transport前受控拒绝", async (kind) => {
    const transport = vi.fn<typeof fetch>();
    const owned = driver({ fetch: transport, ...(kind === "config-only" ? { callback } : {}) });
    const result = await owned.provider.submit({
      url,
      ...(kind === "context-only" ? { callback: { mediaJobId } } : {}),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "rejected",
      acceptance: "not_accepted",
      code: "invalid_input",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(callback.key);
    expect(JSON.stringify(result)).not.toContain(callback.origin);
  });

  it("构造只复制配置且零transport，两实例不串目的地或key", async () => {
    const http = await local();
    const settings = { ...callback };
    const first = driver({ ...http, callback: settings });
    settings.origin = "https://second.example.com";
    settings.key = "b".repeat(32);
    const second = driver({ ...http, callback: settings });
    expect(http.calls).toEqual([]);
    await first.provider.submit({ url, callback: { mediaJobId } });
    await second.provider.submit({ url, callback: { mediaJobId } });
    const firstUrl = JSON.parse(http.calls[0]!.body).CallbackUrl;
    const secondUrl = JSON.parse(http.calls[1]!.body).CallbackUrl;
    expect(firstUrl).toBe(callbackUrl);
    expect(new URL(secondUrl).origin).toBe(settings.origin);
    expect((await receiver().source.verify(request(firstUrl))).kind).toBe("event");
    expect((await receiver(settings.key).source.verify(request(secondUrl))).kind).toBe("event");
    expect(await receiver().source.verify(request(secondUrl))).toMatchObject({
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
  });

  it.each([
    ["UTF8字节32", "密钥".repeat(5) + "ab"],
    ["UTF8字节256", "密钥".repeat(42) + "abcd"],
  ])("发送和真实receiver共享%s密钥原文语义", async (_name, key) => {
    const http = await local();
    const owned = driver({ ...http, callback: { ...callback, key } });
    await owned.provider.submit({ url, callback: { mediaJobId } });
    const destination = JSON.parse(http.calls[0]!.body).CallbackUrl;
    expect((await receiver(key).source.verify(request(destination))).kind).toBe("event");
    expect(
      await receiver(key.replace("密", "钥")).source.verify(request(destination)),
    ).toMatchObject({
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
  });

  it("公开构造拒绝坏配置且零外呼，错误固定脱敏", () => {
    const transport = vi.fn<typeof fetch>();
    expect(() =>
      createTencentAsr(config, {
        now,
        fetch: transport,
        callback: { origin: "http://callbacks.example.com", key: callback.key },
      }),
    ).toThrow(new TypeError("录音转写回调配置不合法"));
    expect(transport).not.toHaveBeenCalled();
  });

  it("成功请求移除caller监听并清原请求timer，guard抛出不送请求", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(submitted)));
    const owned = driver({ fetch: transport, callback });
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await owned.provider.submit({ url, callback: { mediaJobId }, signal: controller.signal });
    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    const denied = withBeforeCall("asr", owned.provider, () => {
      throw new Error("公开guard");
    });
    await expect(denied.submit({ url, callback: { mediaJobId } })).rejects.toThrow("公开guard");
    expect(transport).toHaveBeenCalledTimes(1);
    await owned.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("query原uint64 JSON不附回调，旧同步方法仍unsupported", async () => {
    const http = await local((_call, response) =>
      response.end(
        JSON.stringify({
          Response: {
            RequestId: "public-query",
            Data: { TaskId: 1234, Status: 0, StatusStr: "waiting" },
          },
        }),
      ),
    );
    const owned = driver({ ...http, callback });
    expect(await owned.provider.query({ taskId: "1234" })).toMatchObject({
      ok: true,
      value: { state: "waiting" },
    });
    expect(http.calls[0]!.body).toBe('{"TaskId":1234}');
    expect(http.calls[0]!.headers["x-tc-action"]).toBe("DescribeTaskStatus");
    expect(http.calls[0]!.headers.authorization).toBe(authorization('{"TaskId":1234}'));
    expect(await owned.provider.transcribe({ url })).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    expect(http.calls).toHaveLength(1);
  });

  it("原公开guard每入口恰一次，非法半配不绕guard或外呼", async () => {
    const http = await local();
    const owned = driver({ ...http, callback });
    const guard = vi.fn();
    const provider = withBeforeCall("asr", owned.provider, guard);
    await provider.submit({ url });
    await provider.submit({ url, callback: { mediaJobId } });
    await provider.query({ taskId: "invalid" });
    await provider.transcribe({ url });
    expect(guard.mock.calls).toEqual([
      [{ provider: "asr", method: "submit" }],
      [{ provider: "asr", method: "submit" }],
      [{ provider: "asr", method: "query" }],
      [{ provider: "asr", method: "transcribe" }],
    ]);
    expect(http.calls).toHaveLength(1);
  });

  it("发送前取消不外呼，close幂等且关闭后不重提", async () => {
    const transport = vi.fn<typeof fetch>();
    const owned = driver({ fetch: transport, callback });
    const controller = new AbortController();
    controller.abort();
    expect(
      await owned.provider.submit({ url, signal: controller.signal, callback: { mediaJobId } }),
    ).toMatchObject({ acceptance: "not_accepted", code: "aborted" });
    const closing = owned.close();
    expect(owned.close()).toBe(closing);
    await closing;
    expect(await owned.provider.submit({ url, callback: { mediaJobId } })).toMatchObject({
      acceptance: "not_accepted",
      code: "closed",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["abort", "close", "timeout"] as const)(
    "发送后%s只报告unknown且单次提交/finally回收",
    async (kind) => {
      const entered = { resolve: () => {} };
      const started = new Promise<void>((resolve) => {
        entered.resolve = resolve;
      });
      const cancelled = vi.fn();
      let signal: AbortSignal | undefined;
      let stream: ReadableStream<Uint8Array> | undefined;
      const transport = vi.fn<typeof fetch>(async (_target, init) => {
        signal = init?.signal ?? undefined;
        entered.resolve();
        stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(new Error("公开取消")), {
              once: true,
            });
          },
          cancel: cancelled,
        });
        return new Response(stream);
      });
      const owned = driver({
        fetch: transport,
        callback,
        timeoutMs: kind === "timeout" ? 20 : 10000,
      });
      const controller = new AbortController();
      const pending = owned.provider.submit({
        url,
        signal: controller.signal,
        callback: { mediaJobId },
      });
      await started;
      if (kind === "abort") controller.abort();
      if (kind === "close") await owned.close();
      expect(await pending).toMatchObject({
        ok: false,
        acceptance: "unknown",
        code: kind === "abort" ? "aborted" : kind === "close" ? "closed" : "timeout",
      });
      expect(signal?.aborted).toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      await owned.close();
      expect(stream?.locked).toBe(false);
      expect(cancelled.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("不确定受理不因callback自动重提且错误不泄漏URL/key/正文", async () => {
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error(`${url} ${callback.key} private-response`);
    });
    const owned = driver({ fetch: transport, callback });
    const result = await owned.provider.submit({ url, callback: { mediaJobId } });
    expect(result).toMatchObject({ ok: false, acceptance: "unknown", code: "transport" });
    expect(transport).toHaveBeenCalledTimes(1);
    for (const privateValue of [url, callback.key, "private-response", callback.origin])
      expect(JSON.stringify(result)).not.toContain(privateValue);
  });
});
