import { describe, expect, it, vi } from "vitest";

import { createPortalClient } from "./api";
import { deferred, failure, ok } from "./api.test-helpers";
import { createPortalClientErrorSender, createPortalClientReporting } from "./client-reporting";
import type { PortalClientReportingOptions } from "./client-reporting";

const DSN = "https://fictionalpublic@errors.example.invalid/42";
const BUILD = "7f18e559ecbcc1d552d4df59857173a6d54b5e65";
const UUID = "019a4500-0000-7000-8000-000000000004";
const ORIGIN = "https://portal.example.invalid";
const frame = (line = 7) => ({
  filename: "assets/index-Ab12_cd3.js",
  abs_path: "app:///portal/assets/index-Ab12_cd3.js",
  lineno: line,
  colno: 4,
  in_app: true,
});
const browserError = (line = 7) =>
  Object.assign(new Error("private-raw-message"), {
    stack: `Error: pollSecret=private\n    at fail (${ORIGIN}/assets/index-Ab12_cd3.js:${line}:4)`,
  });
const eventOf = (body: unknown) => JSON.parse(String(body).split("\n")[2]!);
const flush = async () => {
  // Drain the response-json and delivery-finally promises, without clocks or retries.
  for (let n = 0; n < 12; n += 1) await Promise.resolve();
};
function setup(overrides: Partial<Omit<PortalClientReportingOptions, "client">> = {}) {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => ok(null, 202));
  const client = createPortalClient({ fetch: send });
  const reporter = createPortalClientReporting({
    client,
    dsn: DSN,
    build: BUILD,
    origin: ORIGIN,
    now: () => Date.parse("2026-11-04T00:00:00Z"),
    uuid: () => UUID,
    ...overrides,
  });
  return { client, send, reporter };
}

describe("Portal安全错误信封", () => {
  it("生成typed POST保留raw字节/202/null、同源Cookie/CSRF，不产生幂等或认证头", async () => {
    const { client, send, reporter } = setup();
    const raw = '{}\n{"type":"event"}\n{}';
    await expect(createPortalClientErrorSender(client)(raw)).resolves.toBeNull();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/portal/client-errors",
      expect.objectContaining({
        method: "POST",
        body: raw,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    const headers = new Headers(send.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Content-Type")).toBe("application/x-sentry-envelope");
    expect(headers.get("X-LYX-Portal")).toBe("1");
    for (const name of [
      "Idempotency-Key",
      "Cookie",
      "Authorization",
      "X-Poll-Secret",
      "X-Store-Id",
      "Origin",
    ])
      expect(headers.has(name)).toBe(false);
    reporter.dispose();
    client.dispose();
  });

  it("原异常正文/URL/联系人/请求体全丢，只送固定分类、安全ID状态与同源正式编译帧", async () => {
    const { reporter, send } = setup();
    const secret = "private-auth-material";
    const error = Object.assign(new Error(`${secret} 13800138000`), {
      name: secret,
      body: secret,
      user: { contact: secret },
      cause: secret,
      stack: [
        `Error: ${secret}`,
        `at fail (${ORIGIN}/assets/index-Ab12_cd3.js:7:4)`,
        `at foreign (https://outside.invalid/assets/index-Ab12_cd3.js:8:4)`,
        `at query (${ORIGIN}/assets/index-Ab12_cd3.js?code=${secret}:9:4)`,
        `at source (${ORIGIN}/src/main.tsx:1:2)`,
      ].join("\n"),
    });
    reporter.capture(error);
    reporter.report({
      category: "api",
      status: 503,
      requestId: UUID,
      message: secret,
      error,
      body: secret,
      url: `${ORIGIN}/v?code=${secret}`,
      user: { phone: secret },
      headers: { Cookie: secret, Authorization: secret },
      pollSecret: secret,
      stacktrace: { frames: [{ ...frame(), vars: { secret }, source: secret }] },
    });
    expect(send).toHaveBeenCalledTimes(2);
    const raw = String(send.mock.calls[0]?.[1]?.body);
    const lines = raw.split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({
      event_id: UUID.replaceAll("-", ""),
      sent_at: "2026-11-04T00:00:00.000Z",
      dsn: DSN,
    });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
    expect(eventOf(raw)).toEqual({
      event_id: UUID.replaceAll("-", ""),
      timestamp: Date.parse("2026-11-04T00:00:00Z") / 1_000,
      platform: "javascript",
      level: "error",
      release: BUILD,
      dist: "portal",
      tags: { kind: "exception", clientPlatform: "web" },
      exception: {
        values: [
          {
            type: "PortalClientError",
            value: "Portal browser exception",
            stacktrace: { frames: [frame()] },
          },
        ],
      },
    });
    expect(eventOf(send.mock.calls[1]?.[1]?.body).tags).toEqual({
      kind: "api",
      clientPlatform: "web",
      status: "503",
      requestId: UUID,
    });
    for (const [, init] of send.mock.calls)
      expect(String(init?.body)).not.toMatch(
        /private-auth|13800138000|outside\.invalid|code=|pollSecret|Cookie|Authorization|"body"|"user"|"stack"|"vars"/,
      );
    await flush();
    reporter.dispose();
  });

  it.each([
    "",
    "http://key@errors.example.invalid/42",
    "https://key:secret@errors.example.invalid/42",
    `${DSN}?secret=x`,
    `${DSN}#private`,
    "https://key@errors.example.invalid/no-project",
  ])("未配置/非法公开DSN不收集或安装：%s", (dsn) => {
    const now = vi.fn(),
      uuid = vi.fn();
    const { reporter, send } = setup({ dsn, now, uuid });
    const target = new EventTarget() as unknown as Window;
    const add = vi.spyOn(target, "addEventListener");
    const getter = vi.fn(() => {
      throw new Error("private");
    });
    const hostile = Object.defineProperty({}, "stack", { get: getter });
    reporter.capture(hostile);
    reporter.report({ category: "api" });
    reporter.install(target)();
    expect(getter).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    reporter.dispose();
  });

  it("配置后仍不执行原异常stack getter，Proxy异常也不逃逸", () => {
    const { reporter, send } = setup();
    const getter = vi.fn(() => {
      throw new Error("private");
    });
    reporter.capture(Object.defineProperty({}, "stack", { get: getter }));
    reporter.capture(Object.defineProperty(new Error("private"), "stack", { get: getter }));
    expect(getter).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(eventOf(send.mock.calls[0]?.[1]?.body).exception.values[0]).toEqual({
      type: "PortalClientError",
      value: "Portal browser exception",
    });
    expect(() =>
      reporter.capture(new Proxy({}, { getOwnPropertyDescriptor: getter })),
    ).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    reporter.dispose();
  });
});

describe("Portal错误报告生命周期与资源上限", () => {
  it("error/rejection各只装一次，解绑幂等、dispose关闭所有监听与在途请求", async () => {
    const { reporter, send } = setup();
    const target = new EventTarget() as unknown as Window;
    const add = vi.spyOn(target, "addEventListener");
    const off1 = reporter.install(target),
      off2 = reporter.install(target);
    expect(add).toHaveBeenCalledTimes(2);
    const emit = (kind: "error" | "unhandledrejection", line: number) =>
      target.dispatchEvent(
        Object.assign(
          new Event(kind),
          kind === "error" ? { error: browserError(line) } : { reason: browserError(line) },
        ),
      );
    emit("error", 1);
    await flush();
    off1();
    off1();
    emit("unhandledrejection", 2);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(eventOf(send.mock.calls[1]?.[1]?.body).tags.kind).toBe("unhandled_rejection");
    off2();
    emit("error", 3);
    expect(send).toHaveBeenCalledTimes(2);
    reporter.install(target);
    const pending = deferred<Response>();
    send.mockReturnValue(pending.promise);
    emit("error", 4);
    expect(send).toHaveBeenCalledTimes(3);
    expect(eventOf(send.mock.calls[2]?.[1]?.body).exception.values[0].stacktrace.frames).toEqual([
      frame(4),
    ]);
    const signal = send.mock.calls[2]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    reporter.dispose();
    reporter.dispose();
    expect(signal?.aborted).toBe(true);
    emit("error", 5);
    reporter.report({ category: "api" });
    reporter.install(target);
    expect(send).toHaveBeenCalledTimes(3);
    pending.resolve(ok(null, 202));
    await flush();
  });

  it("每分钟10条和去重不因原消息或requestId变化而扩散，60秒边界后只送新安全指纹", async () => {
    let at = 0;
    const { reporter, send } = setup({ now: () => at });
    for (let n = 0; n < 10; n += 1) {
      reporter.report({ category: "api", status: 400 + n });
      await flush();
    }
    reporter.report({ category: "api", status: 500 });
    at = 59_999;
    reporter.report({ category: "api", status: 500 });
    expect(send).toHaveBeenCalledTimes(10);
    at = 60_000;
    reporter.report({
      category: "api",
      status: 400,
      requestId: UUID,
      message: "another private value",
    });
    expect(send).toHaveBeenCalledTimes(10);
    reporter.report({ category: "api", status: 500 });
    await flush();
    expect(send).toHaveBeenCalledTimes(11);
    reporter.dispose();
  });

  it("最多2条在途，无排队；失败不重试、不递归，settle后可以发送新错误", async () => {
    const { reporter, send } = setup();
    const first = deferred<Response>(),
      second = deferred<Response>();
    send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    reporter.report({ category: "api", status: 400 });
    reporter.report({ category: "api", status: 401 });
    reporter.report({ category: "api", status: 402 });
    expect(send).toHaveBeenCalledTimes(2);
    first.resolve(failure("MAINTENANCE", 503));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    reporter.report({ category: "api", status: 402 });
    await flush();
    expect(send).toHaveBeenCalledTimes(3);
    second.resolve(failure("RATE_LIMITED", 429, {}, { "Retry-After": "60" }));
    await flush();
    send.mockRejectedValueOnce(new Error("private transport failure"));
    reporter.report({ category: "api", status: 403 });
    await flush();
    expect(send).toHaveBeenCalledTimes(4);
    reporter.report({ category: "api", status: 403 });
    await flush();
    expect(send).toHaveBeenCalledTimes(4);
    reporter.dispose();
  });

  it("同运行会话最多1000个安全编译帧指纹，后续不同错误受控丢弃", async () => {
    let at = 0;
    const { reporter, send } = setup({ now: () => at });
    for (let n = 0; n < 1_001; n += 1) {
      at = n * 60_000;
      reporter.report({ category: "exception", stacktrace: { frames: [frame(n + 1)] } });
      await flush();
    }
    expect(send).toHaveBeenCalledTimes(1_000);
    reporter.dispose();
  });
});
