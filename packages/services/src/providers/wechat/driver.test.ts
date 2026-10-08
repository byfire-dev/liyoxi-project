import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBeforeCall } from "../types.js";
import type { WechatProvider } from "../types.js";
import { createWechatDriver } from "./driver.js";
import type { TokenRecord, WechatTokenCache } from "./token.js";

const config = {
  appid: "wxfake221",
  secret: "SECRET_NOT_REAL",
  releaseChannel: "release" as const,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const phoneReply = {
  errcode: 0,
  phone_info: {
    phoneNumber: "13800138000",
    purePhoneNumber: "13800138000",
    countryCode: "86",
    watermark: { timestamp: 1_700_000_000, appid: config.appid },
  },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=",
  "base64",
);
function memory(warm = true) {
  let value: TokenRecord | null = warm
    ? { token: "TOKEN_FAKE", expiresAt: Date.now() + 7_200_000 }
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
  return cache;
}
const drivers: ReturnType<typeof createWechatDriver>[] = [];
function make(
  fetchImpl: typeof fetch,
  cache = memory(),
  channel = config.releaseChannel as "develop" | "trial" | "release",
) {
  const driver = createWechatDriver(
    { ...config, releaseChannel: channel },
    { fetchImpl, cache, now: () => new Date(Date.now()) },
  );
  drivers.push(driver);
  return driver;
}
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close()));
  vi.useRealTimers();
});

const calls: Array<(provider: WechatProvider) => Promise<unknown>> = [
  (p) => p.code2Session({ code: "login-fake" }),
  (p) => p.getPhoneNumber({ code: "phone-fake" }),
  (p) =>
    p.sendSubscribeMessage({
      openid: "o-fake",
      templateId: "t-fake",
      data: { thing1: "虚构通知" },
    }),
  (p) => p.createMiniProgramCode({ scene: "a=1" }),
  (p) => p.checkText({ openid: "o-fake", scene: "profile", content: "虚构资料" }),
  (p) =>
    p.checkImage({
      openid: "o-fake",
      scene: "profile",
      mediaUrl: "https://fictional.invalid/image.png",
    }),
];

describe("六方法真实官方请求与最小投影", () => {
  it("初始化0HTTP，登录编码特殊字符且返回不含session_key", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ openid: "o-fake", unionid: "u-fake", session_key: "SECRET_SESSION" }),
      );
    const d = make(f);
    expect(f).not.toHaveBeenCalled();
    expect(await d.provider.code2Session({ code: "a&+?中文" })).toEqual({
      ok: true,
      value: { openid: "o-fake", unionid: "u-fake" },
    });
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.origin).toBe("https://api.weixin.qq.com");
    expect(url.pathname).toBe("/sns/jscode2session");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      appid: config.appid,
      secret: config.secret,
      js_code: "a&+?中文",
      grant_type: "authorization_code",
    });
    expect(f.mock.calls[0]![1]?.method).toBe("GET");
  });

  it.each(["develop", "trial", "release"] as const)(
    "%s订阅和QR版本映射，query只订阅允许",
    async (channel) => {
      const f = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        return path === "/wxa/getwxacodeunlimit" ? new Response(png) : json({ errcode: 0 });
      });
      const d = make(f, memory(), channel);
      const data = JSON.parse('{"thing1":"虚构通知","__proto__":"安全own值"}') as Record<
        string,
        string
      >;
      expect(
        await d.provider.sendSubscribeMessage({
          openid: "o-fake",
          templateId: "t-fake",
          page: "pages/home/index?foo=bar",
          data,
        }),
      ).toEqual({ ok: true, value: undefined });
      const sent = JSON.parse(String(f.mock.calls[0]![1]?.body));
      expect(sent).toEqual({
        touser: "o-fake",
        template_id: "t-fake",
        page: "pages/home/index?foo=bar",
        data: { thing1: { value: "虚构通知" }, ["__proto__"]: { value: "安全own值" } },
        miniprogram_state: { develop: "developer", trial: "trial", release: "formal" }[channel],
        lang: "zh_CN",
      });
      const qr = await d.provider.createMiniProgramCode({ scene: "a=1", page: "pages/home/index" });
      expect(qr).toEqual({
        ok: true,
        value: { image: new Uint8Array(png), contentType: "image/png" },
      });
      expect(JSON.parse(String(f.mock.calls[1]![1]?.body))).toEqual({
        scene: "a=1",
        page: "pages/home/index",
        check_path: true,
        env_version: channel,
      });
      expect(
        await d.provider.createMiniProgramCode({ scene: "a=1", page: "/pages/home/index?bad=1" }),
      ).toMatchObject({ reason: "rejected" });
      expect(f).toHaveBeenCalledTimes(2);
    },
  );

  it("手机号真实country/pure保留，错误AppID不可成功", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(phoneReply))
      .mockResolvedValueOnce(
        json({
          ...phoneReply,
          phone_info: {
            ...phoneReply.phone_info,
            countryCode: "1",
            purePhoneNumber: "13125550199",
            phoneNumber: "+113125550199",
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          ...phoneReply,
          phone_info: { ...phoneReply.phone_info, watermark: { timestamp: 1, appid: "wrong-app" } },
        }),
      );
    const d = make(f);
    expect(await d.provider.getPhoneNumber({ code: "fake1" })).toEqual({
      ok: true,
      value: { phone: "13800138000", countryCode: "86", purePhoneNumber: "13800138000" },
    });
    expect(await d.provider.getPhoneNumber({ code: "fake2" })).toEqual({
      ok: true,
      value: { phone: "+113125550199", countryCode: "1", purePhoneNumber: "13125550199" },
    });
    expect(await d.provider.getPhoneNumber({ code: "fake3" })).toMatchObject({
      reason: "unavailable",
    });
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ code: "fake1" });
    expect(new URL(String(f.mock.calls[0]![0])).searchParams.get("access_token")).toBe(
      "TOKEN_FAKE",
    );
  });

  it.each([
    ["profile", 1],
    ["comment", 2],
    ["forum", 3],
    ["social", 4],
  ] as const)("scene %s→%i，text block而image pending", async (scene, wireScene) => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ errcode: 0, result: { suggest: "risky" }, trace_id: "text-trace" }),
      )
      .mockResolvedValueOnce(json({ errcode: 0, trace_id: "image-trace" }));
    const d = make(f);
    expect(await d.provider.checkText({ openid: "o-fake", scene, content: "虚构文本" })).toEqual({
      ok: true,
      value: { verdict: "block", traceId: "text-trace" },
    });
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      openid: "o-fake",
      scene: wireScene,
      version: 2,
      content: "虚构文本",
    });
    expect(
      await d.provider.checkImage({
        openid: "o-fake",
        scene,
        mediaUrl: "https://fictional.invalid/a.png",
      }),
    ).toEqual({ ok: true, value: { verdict: "pending", traceId: "image-trace" } });
    expect(JSON.parse(String(f.mock.calls[1]![1]?.body))).toEqual({
      openid: "o-fake",
      scene: wireScene,
      version: 2,
      media_type: 2,
      media_url: "https://fictional.invalid/a.png",
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("2500代理对字数及scene32边界，不静默裁内容", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ errcode: 0, result: { suggest: "pass" } }));
    const d = make(f);
    expect(
      await d.provider.checkText({ openid: "o", scene: "profile", content: "🙂".repeat(2500) }),
    ).toMatchObject({ ok: true });
    expect(
      await d.provider.checkText({ openid: "o", scene: "profile", content: "🙂".repeat(2501) }),
    ).toMatchObject({ reason: "rejected" });
    f.mockResolvedValueOnce(new Response(png));
    expect(await d.provider.createMiniProgramCode({ scene: "a".repeat(32) })).toMatchObject({
      ok: true,
    });
    for (const scene of ["a".repeat(33), "中文", "%20"])
      expect(await d.provider.createMiniProgramCode({ scene })).toMatchObject({
        reason: "rejected",
      });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("QR伪MIME/JSON错误和缺suggest/trace/accepted均不可成功", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<html>bad</html>", { headers: { "content-type": "image/png" } }),
      )
      .mockResolvedValueOnce(json({ errcode: 41030 }))
      .mockResolvedValue(json({ errcode: 0 }));
    const d = make(f);
    expect(await d.provider.createMiniProgramCode({ scene: "ok" })).toMatchObject({
      reason: "unavailable",
    });
    expect(await d.provider.createMiniProgramCode({ scene: "ok" })).toMatchObject({
      reason: "rejected",
    });
    expect(
      await d.provider.checkText({ openid: "o", scene: "profile", content: "虚构" }),
    ).toMatchObject({ reason: "unavailable" });
    expect(
      await d.provider.checkImage({
        openid: "o",
        scene: "profile",
        mediaUrl: "https://fictional.invalid/a.png",
      }),
    ).toMatchObject({ reason: "unavailable" });
    f.mockResolvedValue(json({}));
    expect(await calls[2]!(d.provider)).toMatchObject({ reason: "unavailable" });
  });
});

describe("token故障、明确错误和不安全补发保护", () => {
  it.each([40013, 40125, 40164, 40243, 50007])(
    "token端点%i始终unavailable、没有手机号请求",
    async (code) => {
      const f = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ errcode: code, errmsg: "SECRET_NOT_REAL" }));
      const d = make(f, memory(false));
      expect(await d.provider.getPhoneNumber({ code: "valid-phone-code" })).toMatchObject({
        reason: "unavailable",
      });
      expect(f).toHaveBeenCalledTimes(1);
      expect(new URL(String(f.mock.calls[0]![0])).pathname).toBe("/cgi-bin/stable_token");
    },
  );

  it.each([40001, 40014, 42001])("失效%i只CAS清旧token，下次独立调用取新token", async (code) => {
    const cache = memory();
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ errcode: code }))
      .mockResolvedValueOnce(json({ access_token: "TOKEN_NEW_FAKE", expires_in: 7200 }))
      .mockResolvedValueOnce(json(phoneReply));
    const d = make(f, cache);
    expect(await d.provider.getPhoneNumber({ code: "first-single-use" })).toMatchObject({
      reason: "unavailable",
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(cache.deleteIfValue).toHaveBeenCalledWith(config.appid, "TOKEN_FAKE");
    expect(await d.provider.getPhoneNumber({ code: "second-distinct-code" })).toMatchObject({
      ok: true,
    });
    expect(f).toHaveBeenCalledTimes(3);
    expect(new URL(String(f.mock.calls[2]![0])).searchParams.get("access_token")).toBe(
      "TOKEN_NEW_FAKE",
    );
  });

  it.each([40013, 40029])("phone自身明确%i才rejected", async (code) => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ errcode: code }));
    expect(await make(f).provider.getPhoneNumber({ code: "fake-code" })).toMatchObject({
      reason: "rejected",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([500, 429, 200])("网络/HTTP%i未知结果不重发订阅或图片", async (status) => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ errcode: 999999 }, status));
    const d = make(f);
    expect(await calls[2]!(d.provider)).toMatchObject({ reason: "unavailable" });
    expect(await calls[5]!(d.provider)).toMatchObject({ reason: "unavailable" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("六方法仅原外层wrapper各调一次，阻断程序错误不被吞", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ errcode: 0 }));
    const d = make(f);
    const hook = vi.fn();
    const guarded = withBeforeCall("wechat", d.provider, hook);
    for (const call of calls) await call(guarded);
    expect(hook.mock.calls.map(([call]) => call.method)).toEqual([
      "code2Session",
      "getPhoneNumber",
      "sendSubscribeMessage",
      "createMiniProgramCode",
      "checkText",
      "checkImage",
    ]);
    expect(f).toHaveBeenCalledTimes(6);
    const failure = new Error("PROGRAM_GUARD");
    const blocked = withBeforeCall("wechat", d.provider, () => {
      throw failure;
    });
    await expect(calls[0]!(blocked)).rejects.toBe(failure);
    expect(f).toHaveBeenCalledTimes(6);
  });
});

describe("4sHTTP和8s整个方法预算、owned close", () => {
  it("慢cache+token+目标共8s，不能简单把两个4s加缓存；close幂等", async () => {
    vi.useFakeTimers();
    const cache = memory(false);
    vi.mocked(cache.get).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 190)),
    );
    vi.mocked(cache.put).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 190)),
    );
    const signals: AbortSignal[] = [];
    const f = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      const isToken = new URL(String(input)).pathname === "/cgi-bin/stable_token";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3_950);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("ABORTED"));
          },
          { once: true },
        );
      });
      return isToken ? json({ access_token: "TOKEN_FAKE", expires_in: 7200 }) : json(phoneReply);
    });
    const d = make(f, cache);
    const pending = d.provider.getPhoneNumber({ code: "single-use" });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ reason: "unavailable" });
    expect(signals[1]!.aborted).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    await Promise.all([d.close(), d.close()]);
    expect(await d.provider.getPhoneNumber({ code: "after-close" })).toMatchObject({
      reason: "unavailable",
    });
    expect(f).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warm目标单HTTP4s即失败，close清timer", async () => {
    vi.useFakeTimers();
    const f = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const d = make(f);
    const pending = d.provider.getPhoneNumber({ code: "single-use" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toMatchObject({ reason: "unavailable" });
    await d.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cold并发共享取token，close取消全部waiters且不发目标", async () => {
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      started();
      return new Promise(() => {});
    });
    const d = make(f, memory(false));
    const pending = [
      d.provider.getPhoneNumber({ code: "one" }),
      d.provider.getPhoneNumber({ code: "two" }),
    ];
    await start;
    await d.close();
    expect((await Promise.all(pending)).every((r) => !r.ok && r.reason === "unavailable")).toBe(
      true,
    );
    expect(f).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("真实owned本地HTTP慢流在close时中止且socket归零", async () => {
    const sockets = new Set<Socket>();
    const socketClosed: Promise<void>[] = [];
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"errcode":0,');
      arrived();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socketClosed.push(
        new Promise<void>((resolve) =>
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local fake HTTP absent");
    const d = make((input, init) => {
      expect(new URL(String(input)).origin).toBe("https://api.weixin.qq.com");
      return fetch(`http://127.0.0.1:${address.port}/owned`, init);
    });
    try {
      const pending = d.provider.getPhoneNumber({ code: "fake" });
      await arrival;
      await d.close();
      expect(await pending).toMatchObject({ reason: "unavailable" });
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      // server.close回调不是socket监听器已执行的证明；等待实际关闭事件。
      await Promise.all(socketClosed);
      expect(sockets.size).toBe(0);
    } finally {
      await d.close();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
