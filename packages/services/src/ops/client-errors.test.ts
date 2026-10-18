import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTxRunner, KernelViolation } from "../kernel/index.js";
import {
  CLIENT_ERROR_MAX_BYTES,
  CLIENT_ERROR_QUEUE_SIZE,
  createClientErrorForwarder,
} from "./client-errors.js";
import type { ClientErrorForwarder, ClientErrorForwarderOptions } from "./client-errors.js";

const PUBLIC_DSN = "https://fictionalclient@errors.example.invalid/42";
const UPSTREAM_DSN = "https://fictionalupstream@relay.example.invalid/sentry/7";
const EVENT_ID = "abcdef0123456789abcdef0123456789";
const EVENT = { event_id: EVENT_ID, message: "fictional error", level: "error" };
const clock = { now: () => new Date(Date.now()) };
const instances: ClientErrorForwarder[] = [];

function envelope(event: unknown = EVENT, dsn = PUBLIC_DSN): string {
  return `${JSON.stringify({ event_id: EVENT_ID, dsn })}\n{"type":"event"}\n${JSON.stringify(event)}`;
}

function setup(overrides: Partial<ClientErrorForwarderOptions> = {}) {
  const logger = { info: vi.fn() };
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  const instance = createClientErrorForwarder({
    clock,
    logger,
    projects: [{ dsn: PUBLIC_DSN, upstreamDsn: UPSTREAM_DSN }],
    fetch: send,
    ...overrides,
  });
  instances.push(instance);
  return { instance, logger, send };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("错误信封：有界解析、固定白名单与二次去敏", () => {
  it("W227帧：转发只留规范组件路径及正坐标，旧无dist仅诊断文件名，PII与debug_meta仍丢弃", async () => {
    const { instance, send } = setup();
    const canonical = {
      filename: "sub/profile/review/index.js",
      abs_path: "app:///weapp/sub/profile/review/index.js",
      lineno: 2,
      colno: 9,
      in_app: true,
    };
    const frames = [
      {
        ...canonical,
        function: "private function",
        vars: { token: "raw-secret" },
        pre_context: ["private source"],
      },
      { ...canonical, abs_path: "https://elsewhere.invalid/app.js" },
      { ...canonical, colno: 0 },
      { ...canonical, filename: "../app.js" },
      { filename: "app.js", lineno: 3, colno: 4, in_app: true },
    ];
    instance.accept(
      envelope({
        ...EVENT,
        release: "sha-0123456789ab",
        dist: "weapp",
        debug_meta: { images: [{ debug_id: "private-debug" }] },
        exception: { values: [{ type: "Error", value: "13800138000", stacktrace: { frames } }] },
      }),
    );
    instance.accept(
      envelope({
        ...EVENT,
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  { filename: "app.js", vars: { token: "raw-secret" }, lineno: 7, in_app: true },
                ],
              },
            },
          ],
        },
      }),
    );
    instance.accept(
      envelope({
        ...EVENT,
        dist: "unknown",
        exception: {
          values: [{ stack: "unknown diagnostic", stacktrace: { frames: [canonical] } }],
        },
      }),
    );
    await instance.drain();
    expect(send).toHaveBeenCalledTimes(3);
    const sent = send.mock.calls.map((call) => JSON.parse(String(call[1]!.body).split("\n")[2]!));
    expect(sent[0]).toMatchObject({ release: "sha-0123456789ab", dist: "weapp" });
    expect(sent[0].exception.values[0].stacktrace.frames).toEqual([canonical]);
    expect(sent[1].exception.values[0].stacktrace.frames).toEqual([{ filename: "app.js" }]);
    expect(sent[2].exception.values[0]).toEqual({ stack: "unknown diagnostic" });
    for (const call of send.mock.calls)
      expect(String(call[1]!.body)).not.toMatch(
        /raw-secret|private source|private function|private-debug|13800138000|debug_meta/,
      );
    expect(instance.snapshot()).toMatchObject({ forwarded: 3, failed: 0 });
  });

  it("受理不等待 fetch；固定 FILE 上游、禁止重定向，输出长度是真正 UTF-8 字节数", async () => {
    let finish!: (response: Response) => void;
    const send = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { instance } = setup({ fetch: send });
    expect(instance.accept(envelope({ ...EVENT, message: "虚构故障" }))).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe("https://relay.example.invalid/sentry/api/7/envelope/");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(init!.headers).toEqual({
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": "Sentry sentry_version=7, sentry_key=fictionalupstream",
    });
    const [header, item, payload] = String(init!.body).split("\n");
    expect(JSON.parse(header!)).toMatchObject({ dsn: UPSTREAM_DSN, event_id: EVENT_ID });
    expect(JSON.parse(item!).length).toBe(Buffer.byteLength(payload!));
    finish(new Response(null));
    await instance.drain();
    expect(instance.snapshot()).toMatchObject({ forwarded: 1, failed: 0, active: 0 });
  });

  it.each([
    "https://fictionalclient@169.254.169.254/42",
    "https://otherkey@errors.example.invalid/42",
    "https://fictionalclient@errors.example.invalid/43",
    `${PUBLIC_DSN}?redirect=https://127.0.0.1`,
    `${PUBLIC_DSN}#secret`,
    "https://fictionalclient:password@errors.example.invalid/42",
    "http://fictionalclient@errors.example.invalid/42",
    "https://fictionalclient@errors.example.invalid/non-numeric",
  ])("拒绝未登记或非法 DSN %s；无外呼、无原文日志", async (dsn) => {
    const { instance, send, logger } = setup();
    expect(() => instance.accept(envelope(EVENT, dsn))).toThrow(
      expect.objectContaining({ error: "VALIDATION_FAILED" }),
    );
    await instance.drain();
    expect(send).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(instance.snapshot().accepted).toBe(0);
  });

  it("凭据、请求体、用户其它字段、嵌套键与文本二次去敏；不保留输入头附件 metadata", async () => {
    const { instance, send } = setup();
    const event = {
      ...EVENT,
      message:
        "13800138000 91430100MA4L12345X lyxm_fictionalsecret Bearer fictionalsecret token=fictionalsecret https://user:pass@site.invalid/path?token=secret#token",
      user: {
        id: "11111111-1111-7111-8111-111111111111",
        email: "private@example.invalid",
        ip_address: "10.1.2.3",
        username: "private",
      },
      request: {
        data: "raw-body",
        headers: { authorization: "fictionalsecret" },
        cookies: "private",
      },
      contexts: {
        nested: {
          access_token: "fictionalsecret",
          password: "raw-password",
          apiKey: "raw-api-key",
          credential: "raw-credential",
          authorization: "secret",
          licenseNo: "secret",
          code: "activation",
          data: "raw-body",
          message: "13800138000",
          numbers: [13800138000],
        },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "Bearer fictionalsecret",
            stack: "https://user:pass@site.invalid/app.js?token=secret#secret",
            stacktrace: { frames: [{ filename: "app.js", vars: { token: "secret" } }] },
          },
        ],
      },
      extra: { text: '{"password":"raw-json-password","token":"raw-json-token"}' },
    };
    const raw = `${JSON.stringify({ dsn: PUBLIC_DSN, event_id: EVENT_ID, sdk: { secret: "raw-header-secret" }, trace: { credential: "raw-trace" } })}\n{"type":"event","filename":"raw-name"}\n${JSON.stringify(event)}`;
    instance.accept(raw);
    await instance.drain();
    const body = String(send.mock.calls[0]![1]!.body);
    for (const secret of [
      "13800138000",
      "91430100MA4L12345X",
      "fictionalsecret",
      "raw-body",
      "raw-password",
      "raw-api-key",
      "raw-credential",
      "raw-json-password",
      "raw-json-token",
      "activation",
      "raw-header-secret",
      "raw-trace",
      "raw-name",
      "user:pass",
      "?token=",
      "#secret",
      "private@example",
    ])
      expect(body).not.toContain(secret);
    const cleaned = JSON.parse(body.split("\n")[2]!);
    expect(cleaned.user).toEqual({ id: event.user.id });
    expect(cleaned.request).toBeUndefined();
    expect(cleaned.contexts.nested).toEqual({ message: "[redacted]", numbers: ["[redacted]"] });
    expect(cleaned.exception.values[0].stacktrace.frames[0]).toEqual({ filename: "app.js" });
  });

  it("length 用字节数并允许 JSON 内换行；含换行/非法 UTF-8 的二进制附件有限消费后丢弃", async () => {
    const { instance, send } = setup();
    const payload = Buffer.from(JSON.stringify({ ...EVENT, message: "中文" }, null, 2));
    const raw = Buffer.concat([
      Buffer.from(
        `${JSON.stringify({ dsn: PUBLIC_DSN, event_id: EVENT_ID })}\n${JSON.stringify({ type: "attachment", length: 4, filename: "secret-file" })}\n`,
      ),
      Buffer.from([255, 10, 0, 128]),
      Buffer.from(`\n${JSON.stringify({ type: "event", length: payload.length })}\n`),
      payload,
    ]);
    instance.accept(raw);
    await instance.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![1]!.body)).not.toContain("secret-file");
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body).split("\n")[2]!).message).toBe("中文");
  });

  it("200KiB 含边界接受，200KiB+1 字节拒绝；多字节字符串按字节而非 JS length", async () => {
    const { instance, send } = setup();
    const prefix = `${JSON.stringify({ dsn: PUBLIC_DSN })}\n${JSON.stringify({ type: "attachment", length: 200000 })}\n`;
    // length 的位数稳定；实际附件恰好填满边界，附件不向上游转发。
    const fill = CLIENT_ERROR_MAX_BYTES - Buffer.byteLength(prefix);
    const header = `${JSON.stringify({ dsn: PUBLIC_DSN })}\n${JSON.stringify({ type: "attachment", length: fill })}\n`;
    expect(Buffer.byteLength(header)).toBe(Buffer.byteLength(prefix));
    const exact = Buffer.concat([Buffer.from(header), Buffer.alloc(fill, 97)]);
    expect(exact.length).toBe(CLIENT_ERROR_MAX_BYTES);
    instance.accept(exact);
    expect(() => instance.accept(Buffer.concat([exact, Buffer.from("\n")]))).toThrow(
      expect.objectContaining({ error: "VALIDATION_FAILED" }),
    );
    expect(() => instance.accept(envelope({ ...EVENT, message: "中".repeat(70_000) }))).toThrow(
      expect.objectContaining({ error: "VALIDATION_FAILED" }),
    );
    await instance.drain();
    expect(send).not.toHaveBeenCalled();
    expect(instance.snapshot()).toMatchObject({ accepted: 1, dropped: 1 });
  });

  it.each([
    "",
    "{}",
    "{}\n",
    `${JSON.stringify({ dsn: PUBLIC_DSN })}\n`,
    `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event","length":-1}\n{}`,
    `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event","length":999}\n{}`,
    `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event","length":2}\n{}x`,
    `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event"}\n[]`,
    `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event"}\n{not json}`,
    `${envelope()}\n{"type":"event"}\n{}`,
    envelope({ ...EVENT, event_id: "0123456789abcdef0123456789abcdef" }),
  ])("真实畸形信封拒绝（case %#），不保存 JSON 原因", (raw) => {
    const { instance } = setup();
    try {
      instance.accept(raw);
      throw new Error("must reject");
    } catch (error) {
      expect(error).toMatchObject({ error: "VALIDATION_FAILED", cause: undefined });
      expect(String(error)).toBe("AppError: 错误上报信封不合规");
    }
  });

  it("恶意深度受控拒绝；__proto__/敏感嵌套字段不污染对象", async () => {
    const { instance, send } = setup();
    const nested = `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event"}\n${'{"a":'.repeat(40)}{}${"}".repeat(40)}`;
    expect(() => instance.accept(nested)).toThrow(
      expect.objectContaining({ error: "VALIDATION_FAILED" }),
    );
    instance.accept(
      `${JSON.stringify({ dsn: PUBLIC_DSN })}\n{"type":"event"}\n{"__proto__":{"polluted":true},"constructor":{"password":"secret"},"message":"safe"}`,
    );
    await instance.drain();
    expect(String(send.mock.calls[0]![1]!.body)).not.toMatch(/polluted|constructor/);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("完全未配置仍严格解析、去敏、202形态同步受理；指定项目没上游也降级，日志只计状态", async () => {
    for (const projects of [[], [{ dsn: PUBLIC_DSN }]]) {
      const { instance, send, logger } = setup({ projects });
      instance.accept(envelope({ ...EVENT, message: "lyxm_secret 13800138000" }));
      expect(() => instance.accept("invalid secret")).toThrow();
      await instance.drain();
      expect(send).not.toHaveBeenCalled();
      expect(logger.info.mock.calls).toEqual([
        [{ evt: "telemetry.forward", outcome: "unconfigured" }, "错误上报转发"],
      ]);
      expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/lyxm_|13800138000|https:|secret/);
    }
  });

  it("配置的凭据/协议/重复项目不合规，不把内容写进错误", () => {
    for (const projects of [
      [{ dsn: PUBLIC_DSN, upstreamDsn: "http://secret@localhost/7" }],
      [{ dsn: PUBLIC_DSN, upstreamDsn: "https://key:password@host.invalid/7" }],
      [{ dsn: PUBLIC_DSN }, { dsn: PUBLIC_DSN }],
      Array.from({ length: 4 }, (_, n) => ({ dsn: `https://key@errors.example.invalid/${n}` })),
    ]) {
      expect(() =>
        createClientErrorForwarder({ clock, logger: { info: vi.fn() }, projects }),
      ).toThrow();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("转发队列、时间窗口与生命周期", () => {
  it("队列满200丢最新计数，每实例同时只两个外呼；close取消在途并清待发", async () => {
    const signals: AbortSignal[] = [];
    const send = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      signals.push(init!.signal!);
      return new Promise(() => {}); // 即使替身不响应 abort，close 也由取消 race 收尾。
    });
    const { instance } = setup({ fetch: send });
    for (let n = 0; n < CLIENT_ERROR_QUEUE_SIZE; n += 1)
      instance.accept(envelope({ ...EVENT, message: String(n) }));
    instance.accept(envelope({ ...EVENT, message: "newest-dropped" }));
    expect(instance.snapshot()).toMatchObject({ queued: 200, active: 0, dropped: 1 });
    await Promise.resolve();
    expect(instance.snapshot()).toMatchObject({ queued: 198, active: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    await instance.close();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(instance.snapshot()).toMatchObject({ queued: 0, active: 0, closed: true, dropped: 201 });
    instance.accept(envelope());
    expect(instance.snapshot().dropped).toBe(202);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("2秒超时取消真实 signal、失败即丢弃无重试；1,999ms尚在途", async () => {
    let signal!: AbortSignal;
    const send = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      signal = init!.signal!;
      return new Promise(() => {});
    });
    const { instance } = setup({ fetch: send });
    instance.accept(envelope());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(instance.snapshot().active).toBe(1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await instance.drain();
    expect(signal.aborted).toBe(true);
    expect(instance.snapshot()).toMatchObject({ failed: 1, dropped: 1, forwarded: 0, active: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("上游错误正文从不读取，响应流 cancel 成功仍按非2xx失败", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const text = vi.fn().mockRejectedValue(new Error("不能读取正文"));
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, body: { cancel }, text } as unknown as Response);
    const { instance, logger } = setup({ fetch: send });
    instance.accept(envelope());
    await instance.drain();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(instance.snapshot()).toMatchObject({ failed: 1, dropped: 1 });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("响应 cancel 挂起同样受2秒预算，不阻塞 drain/close", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, body: { cancel } } as unknown as Response);
    const { instance } = setup({ fetch: send });
    instance.accept(envelope());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    await instance.drain();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(instance.snapshot()).toMatchObject({ failed: 1, active: 0 });
  });

  it("10秒内第5次失败打开60秒；待发与熔断期新消息全部丢弃，边界到时恢复", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("fictional upstream secret"));
    const { instance, logger } = setup({ fetch: send });
    for (let n = 0; n < 4; n += 1) {
      instance.accept(envelope());
      await instance.drain();
    }
    expect(instance.snapshot().breakerOpen).toBe(false);
    // 4次发生在0，故第5次正好10秒仍在窗口内。
    await vi.advanceTimersByTimeAsync(10_000);
    for (let n = 0; n < 10; n += 1) instance.accept(envelope());
    await instance.drain();
    expect(instance.snapshot()).toMatchObject({
      breakerOpen: true,
      queued: 0,
      active: 0,
      dropped: 14,
    });
    const calls = send.mock.calls.length;
    instance.accept(envelope());
    expect(send).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(instance.snapshot().breakerOpen).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: "telemetry.forward",
        outcome: "summary",
        breakerOpen: true,
        dropped: 15,
      }),
      "错误上报转发",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret");
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.snapshot().breakerOpen).toBe(false);
    send.mockResolvedValue(new Response(null));
    instance.accept(envelope());
    await instance.drain();
    expect(instance.snapshot().forwarded).toBe(1);
  });

  it("窗口外的旧失败不计入熔断；成功也不抹掉窗口内真实失败", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("unavailable"));
    const { instance } = setup({ fetch: send });
    for (let n = 0; n < 4; n += 1) {
      instance.accept(envelope());
      await instance.drain();
    }
    await vi.advanceTimersByTimeAsync(10_001);
    instance.accept(envelope());
    await instance.drain();
    expect(instance.snapshot().breakerOpen).toBe(false);
    send.mockResolvedValue(new Response(null));
    instance.accept(envelope());
    await instance.drain();
    send.mockRejectedValue(new Error("unavailable"));
    for (let n = 0; n < 4; n += 1) {
      instance.accept(envelope());
      await instance.drain();
    }
    expect(instance.snapshot()).toMatchObject({ forwarded: 1, breakerOpen: true });
  });

  it("close 幂等、未开始的 microtask 不发请求，logger故障不阻断受理", async () => {
    const { instance, send } = setup();
    instance.accept(envelope());
    await Promise.all([instance.close(), instance.close()]);
    await instance.drain();
    expect(send).not.toHaveBeenCalled();
    const fallback = setup({
      projects: [],
      logger: {
        info: () => {
          throw new Error("log failure");
        },
      },
    });
    expect(fallback.instance.accept(envelope())).toBeUndefined();
  });

  it("真实 kernel AsyncLocalStorage 事务守卫：accept立即拒绝，queue/fetch均0", async () => {
    const fakePrisma = {
      $transaction: async (
        fn: (handle: { $queryRawUnsafe: () => Promise<unknown[]> }) => Promise<unknown>,
      ) => fn({ $queryRawUnsafe: async () => [] }),
    } as unknown as Parameters<typeof createTxRunner>[0]["prisma"];
    const tx = createTxRunner({ prisma: fakePrisma, appEnv: "test" });
    const { instance, send } = setup();
    await expect(
      tx.run(async () => {
        instance.accept(envelope());
      }),
    ).rejects.toBeInstanceOf(KernelViolation);
    expect(send).not.toHaveBeenCalled();
    expect(instance.snapshot()).toMatchObject({ accepted: 0, queued: 0 });
    instance.accept(envelope());
    await instance.drain();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("真实本地 HTTP：仅虚构上游、无外网", () => {
  it("Node fetch 真 POST清洗信封、取消在途socket，关停后无owned服务器连接", async () => {
    vi.useRealTimers();
    let server: Server | undefined;
    const received: string[] = [];
    const sockets = new Set<Socket>();
    const socketCloses: Promise<void>[] = [];
    let hangingClosed!: () => void;
    const requestClosed = new Promise<void>((resolve) => {
      hangingClosed = resolve;
    });
    let hangingStarted!: () => void;
    const hanging = new Promise<void>((resolve) => {
      hangingStarted = resolve;
    });
    let requests = 0;
    let origin = "";
    let path = "/fictional";
    let trapRequests = 0;
    try {
      server = createServer((req, res) => {
        if (req.url === "/redirect") {
          req.resume();
          res.writeHead(307, { location: `${origin}/trap` });
          res.end("fictional redirect");
          return;
        }
        if (req.url === "/trap") {
          trapRequests += 1;
          req.resume();
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          received.push(Buffer.concat(chunks).toString());
          requests += 1;
          if (requests === 1) {
            res.writeHead(200);
            res.end("fictional accepted");
          } else {
            req.socket.once("close", hangingClosed);
            hangingStarted();
          }
        });
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socketCloses.push(
          new Promise<void>((resolve) => {
            socket.once("close", () => {
              sockets.delete(socket);
              resolve();
            });
          }),
        );
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("own server missing");
      origin = `http://127.0.0.1:${address.port}`;
      const nativeFetch = fetch;
      // 配置始终是虚构HTTPS；测试替身只将该固定目的地映射到自有loopback服务器。
      const send: typeof fetch = async (url, init) => {
        expect(url).toBe("https://relay.example.invalid/sentry/api/7/envelope/");
        return nativeFetch(`${origin}${path}`, init);
      };
      const { instance } = setup({ fetch: send });
      instance.accept(envelope({ ...EVENT, message: "13800138000 lyxm_secret" }));
      await instance.drain();
      expect(instance.snapshot().forwarded).toBe(1);
      expect(received[0]).not.toMatch(/13800138000|lyxm_secret/);
      path = "/redirect";
      instance.accept(envelope());
      await instance.drain();
      expect(instance.snapshot().failed).toBe(1);
      expect(trapRequests).toBe(0); // 真实Node fetch拒绝307，未跟随受控上游的任意Location。
      path = "/fictional";
      instance.accept(envelope());
      await hanging;
      await instance.close();
      expect(instance.snapshot()).toMatchObject({ active: 0, queued: 0, closed: true });
      // 清场销毁server连接之前，单独确认真实fetch的abort关闭了在途请求。
      let closeDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          requestClosed,
          new Promise<never>((_resolve, reject) => {
            closeDeadline = setTimeout(
              () => reject(new Error("native fetch did not close owned request")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (closeDeadline) clearTimeout(closeDeadline);
      }
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
        // close callback不保证socket close事件已派发，逐个等真实收尾。
        await Promise.all(socketCloses);
      }
      vi.useFakeTimers();
    }
    expect(sockets.size).toBe(0);
  });
});
