import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBeforeCall } from "../types.js";
import { createWechatDriver } from "./driver.js";
import type { TokenRecord, WechatTokenCache } from "./token.js";

const config = { appid: "wxfake221sub", secret: "SECRET_FAKE", releaseChannel: "release" as const };
const input = { openid: "OPENID_FAKE", templateId: "TEMPLATE_FAKE", data: { thing1: "虚构内容" } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const drivers: ReturnType<typeof createWechatDriver>[] = [];
function make(fetchImpl: typeof fetch, warm = true) {
  let value: TokenRecord | null = warm
    ? { token: "TOKEN_FAKE", expiresAt: Date.now() + 7200000 }
    : null;
  const cache: WechatTokenCache = {
    get: vi.fn(async () => value),
    put: vi.fn(async (_appid, next) => {
      value = next;
    }),
    deleteIfValue: vi.fn(async (_appid, token) => {
      if (value?.token === token) value = null;
    }),
  };
  const driver = createWechatDriver(config, { cache, fetchImpl, now: () => new Date() });
  drivers.push(driver);
  return { ...driver, cache };
}
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((d) => d.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("实际订阅驱动有限受理事实", () => {
  it.each([
    [40003, "invalid_openid"],
    [40037, "template_invalid"],
    [43101, "no_quota"],
    [43107, "provider_rejected"],
    [45168, "provider_rejected"],
    [47003, "field_mismatch"],
    [43108, "rate_limited"],
    [40001, "provider_rejected"],
    [40014, "provider_rejected"],
    [42001, "provider_rejected"],
  ])("完整2xx拒绝%i→%s，不泄露或补发", async (code, mapped) => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ errcode: code, errmsg: "SECRET_RAW" }));
    const result = await make(f).provider.sendSubscribeMessage(input);
    expect(result).toMatchObject({
      ok: false,
      notification: { acceptance: "not_accepted", code: mapped },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|TOKEN|OPENID|TEMPLATE/);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([200, 429, 500, 302])("未知/HTTP%i未知受理", async (status) => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ errcode: status === 200 ? 999999 : 43101 }, status));
    expect(await make(f).provider.sendSubscribeMessage(input)).toMatchObject({
      reason: "unavailable",
      notification: { acceptance: "unknown", code: "unknown_outcome" },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("明确零码不造msgId，畸形成功不伪受理", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ errcode: 0, errmsg: "ok", msgid: "UNSUPPORTED_FAKE" }))
      .mockResolvedValueOnce(json({}));
    const d = make(f);
    expect(await d.provider.sendSubscribeMessage(input)).toEqual({ ok: true, value: undefined });
    expect(await d.provider.sendSubscribeMessage(input)).toMatchObject({
      notification: { acceptance: "unknown", code: "unknown_outcome" },
    });
  });
  it("token失败目标未发，input和body本地拒绝未受理", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ errcode: 40125, errmsg: "SECRET" }));
    const d = make(f, false);
    expect(await d.provider.sendSubscribeMessage(input)).toMatchObject({
      reason: "unavailable",
      notification: { acceptance: "not_accepted" },
    });
    expect(new URL(String(f.mock.calls[0]![0])).pathname).toBe("/cgi-bin/stable_token");
    expect(await d.provider.sendSubscribeMessage({ ...input, openid: "" })).toMatchObject({
      notification: { acceptance: "not_accepted", code: "field_mismatch" },
    });
    expect(
      await d.provider.sendSubscribeMessage({ ...input, data: { thing1: "a".repeat(65536) } }),
    ).toMatchObject({ notification: { acceptance: "not_accepted", code: "field_mismatch" } });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("取消先后、共享token与late事实", () => {
  it("预取消0cache/0HTTP且不绕外层guard", async () => {
    const f = vi.fn<typeof fetch>();
    const d = make(f);
    const c = new AbortController();
    c.abort(new Error("SECRET_ABORT_REASON"));
    expect(await d.provider.sendSubscribeMessage({ ...input, signal: c.signal })).toMatchObject({
      notification: { acceptance: "not_accepted", code: "aborted" },
    });
    expect(d.cache.get).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    const problem = new Error("GUARD_PROGRAM_ERROR");
    const guarded = withBeforeCall("wechat", d.provider, () => {
      throw problem;
    });
    await expect(guarded.sendSubscribeMessage({ ...input, signal: c.signal })).rejects.toBe(
      problem,
    );
    expect(f).not.toHaveBeenCalled();
  });
  it("一caller取消不杀共享cold token，另一caller只发一次目标", async () => {
    let release!: (response: Response) => void;
    let arrived!: () => void;
    const start = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let tokenSignal!: AbortSignal;
    const f = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/cgi-bin/stable_token") {
        tokenSignal = init?.signal as AbortSignal;
        arrived();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json({ errcode: 0 });
    });
    const d = make(f, false);
    const c = new AbortController();
    const one = d.provider.sendSubscribeMessage({ ...input, signal: c.signal });
    const two = d.provider.sendSubscribeMessage(input);
    await start;
    c.abort();
    expect(await one).toMatchObject({
      notification: { acceptance: "not_accepted", code: "aborted" },
    });
    expect(tokenSignal.aborted).toBe(false);
    release(json({ access_token: "TOKEN_NEW_FAKE", expires_in: 7200 }));
    expect(await two).toMatchObject({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("目标已发取消结果unknown，不重发且清timer", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    let signal!: AbortSignal;
    const f = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      started();
      return new Promise(() => {});
    });
    const d = make(f);
    const c = new AbortController();
    const result = d.provider.sendSubscribeMessage({ ...input, signal: c.signal });
    await start;
    c.abort(new Error("SECRET_ABORT"));
    expect(await result).toMatchObject({
      notification: { acceptance: "unknown", code: "aborted" },
    });
    expect(signal.aborted).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    await d.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("已解码token拒绝在CAS中取消不能覆盖", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ errcode: 40001 }));
    const d = make(f);
    const c = new AbortController();
    vi.mocked(d.cache.deleteIfValue).mockImplementation(async () => {
      c.abort();
    });
    expect(await d.provider.sendSubscribeMessage({ ...input, signal: c.signal })).toMatchObject({
      notification: { acceptance: "not_accepted", code: "provider_rejected" },
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(d.cache.deleteIfValue).toHaveBeenCalledTimes(1);
  });
  it.each([0, 43101, 999999])("已完成JSON解码%i后取消保留真实投影", async (code) => {
    const c = new AbortController();
    const literal = JSON.stringify({ errcode: code });
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const result = parse(text);
      if (text === literal) queueMicrotask(() => c.abort());
      return result;
    });
    const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(literal));
    const result = await make(f).provider.sendSubscribeMessage({ ...input, signal: c.signal });
    expect(c.signal.aborted).toBe(true);
    if (code === 0) expect(result).toEqual({ ok: true, value: undefined });
    else
      expect(result).toMatchObject({
        notification:
          code === 43101
            ? { acceptance: "not_accepted", code: "no_quota" }
            : { acceptance: "unknown", code: "unknown_outcome" },
      });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("真实owned socket目标开始后取消、close资源归零", async () => {
    const sockets = new Set<Socket>();
    const closed: Promise<void>[] = [];
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => {
      arrived = r;
    });
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.write('{"errcode":');
      arrived();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      closed.push(
        new Promise<void>((r) =>
          socket.once("close", () => {
            sockets.delete(socket);
            r();
          }),
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OWNED_SERVER_ABSENT");
    const d = make((url, init) => {
      expect(new URL(String(url)).origin).toBe("https://api.weixin.qq.com");
      return fetch(`http://127.0.0.1:${address.port}/owned`, init);
    });
    const c = new AbortController();
    try {
      const pending = d.provider.sendSubscribeMessage({ ...input, signal: c.signal });
      await arrival;
      c.abort();
      expect(await pending).toMatchObject({
        notification: { acceptance: "unknown", code: "aborted" },
      });
      await d.close();
      server.closeIdleConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await Promise.all(closed);
      expect(sockets.size).toBe(0);
    } finally {
      await d.close();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
