import { describe, expect, it, vi } from "vitest";

import { createAdminApi } from "../lib/api";
import type { ApiHandlers } from "../lib/api";
import { createAdminClientErrorSender, createAdminClientReporting } from "./client-reporting";
import type { AdminClientReportingOptions } from "./client-reporting";

const DSN = "https://fictionalpublic@errors.example.invalid/42";
const UUID = "01234567-89ab-7cde-8fab-0123456789ab";
const USER_ID = "11111111-1111-7111-8111-111111111111";
const BUILD = "fictional-build-18";
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const handlers = (): ApiHandlers => ({
  redirectToLogin: vi.fn(),
  stepUp: vi.fn(async () => false),
  refreshAccess: vi.fn(),
  invalidateQueries: vi.fn(),
  notify: vi.fn(),
  showBlocked: vi.fn(),
  buildMismatch: vi.fn(),
});
const accepted = () =>
  new Response(JSON.stringify({ data: null }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });

function setup(overrides: Partial<AdminClientReportingOptions> = {}) {
  const sender = vi.fn<(raw: string) => Promise<unknown>>().mockResolvedValue(undefined);
  const reporter = createAdminClientReporting({
    dsn: DSN,
    build: BUILD,
    sender,
    uuid: () => UUID,
    now: () => Date.parse("2026-10-01T00:00:00Z"),
    getUserId: () => USER_ID,
    ...overrides,
  });
  return { reporter, sender };
}
const eventOf = (raw: string) => JSON.parse(raw.split("\n")[2]!);

it("W227帧：后台实际信封绑定build/admin与同源完整资产路径，原去敏及发送限制保持", async () => {
  const origin = "https://admin.example.invalid",
    build = "sha-0123456789ab";
  const { reporter, sender } = setup({ origin, build });
  const error = new Error("联系 13800138000");
  error.stack = [
    "Error: fixture",
    `at fail (${origin}/assets/index-Ab12_cd3.js:5:8)`,
    `boot@${origin}/assets/index-Ab12_cd3.js:1:2`,
    `at foreign (https://elsewhere.invalid/assets/index-Ab12_cd3.js:2:2)`,
    `at credential (https://user:pass@admin.example.invalid/assets/index-Ab12_cd3.js:3:3)`,
    `at query (${origin}/assets/index-Ab12_cd3.js?token=raw-secret:4:4)`,
    `at phone (${origin}/assets/13800138000-Ab12_cd3.js:1:1)`,
    `at token (${origin}/assets/lyxm_fictional-Ab12_cd3.js:1:1)`,
  ].join("\n");
  reporter.capture(error);
  reporter.capture(error);
  expect(sender).toHaveBeenCalledTimes(1);
  const raw = sender.mock.calls[0]![0],
    event = eventOf(raw);
  expect(event).toMatchObject({ release: build, dist: "admin" });
  expect(event.exception.values[0].stacktrace.frames).toEqual([
    {
      filename: "assets/index-Ab12_cd3.js",
      abs_path: "app:///admin/assets/index-Ab12_cd3.js",
      lineno: 1,
      colno: 2,
      in_app: true,
    },
    {
      filename: "assets/index-Ab12_cd3.js",
      abs_path: "app:///admin/assets/index-Ab12_cd3.js",
      lineno: 5,
      colno: 8,
      in_app: true,
    },
  ]);
  expect(raw).not.toMatch(/13800138000|user:pass|raw-secret/);
  expect(event.exception.values[0].stack).toContain("elsewhere.invalid");
  await flush();
  const unknown = new Error("unknown frame");
  unknown.stack = "at /srv/server.js:3:7";
  reporter.capture(unknown);
  expect(eventOf(sender.mock.calls[1]![0]).exception.values[0]).toMatchObject({
    stack: unknown.stack,
  });
  expect(eventOf(sender.mock.calls[1]![0]).exception.values[0].stacktrace).toBeUndefined();
  await flush();
  for (let index = 0; index < 9; index += 1) {
    reporter.capture(`bounded-${index}`);
    await flush();
  }
  expect(sender).toHaveBeenCalledTimes(10);
  const off = setup({ dsn: "", origin });
  off.reporter.capture(error);
  expect(off.sender).not.toHaveBeenCalled();
});

describe("后台轻量信封：真实中央请求路径与安全边界", () => {
  it("production helper经generated typedPOST发送raw envelope，保留中央请求头/cookie/202", async () => {
    const requests: Request[] = [];
    const api = createAdminApi({
      build: BUILD,
      baseUrl: "https://admin.example.invalid",
      handlers: handlers(),
      newRequestId: () => UUID,
      fetch: async (request) => {
        requests.push(request.clone());
        return accepted();
      },
    });
    const send = createAdminClientErrorSender(api.client);
    const result = (await send('{"dsn":"fictional"}\n{"type":"event"}\n{"message":"中文"}')) as {
      data: { data: null };
      response: Response;
    };
    expect(result.response.status).toBe(202);
    expect(result.data).toEqual({ data: null });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://admin.example.invalid/api/v1/admin/client-errors");
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("same-origin");
    expect(request.headers.get("Content-Type")).toBe("application/x-sentry-envelope");
    expect(request.headers.get("X-LYX-Admin")).toBe("1");
    expect(request.headers.get("X-Client-Version")).toBe(BUILD);
    expect(request.headers.get("X-Request-Id")).toBe(UUID);
    expect(await request.text()).toBe('{"dsn":"fictional"}\n{"type":"event"}\n{"message":"中文"}');
  });

  it("reporter实际经centralAPI受理，安全error/stack/build/id，body与headers不参与构造", async () => {
    let sent = "";
    const received = new Promise<void>((resolve) => {
      const api = createAdminApi({
        build: BUILD,
        baseUrl: "https://admin.example.invalid",
        handlers: handlers(),
        fetch: async (request) => {
          sent = await request.text();
          resolve();
          return accepted();
        },
      });
      const { reporter } = setup({ sender: createAdminClientErrorSender(api.client) });
      const error = Object.assign(
        new Error(
          "虚构 13800138000 91430100MA4L12345X lyxa_secret Bearer tokenvalue password=raw-password",
        ),
        {
          body: "raw-body",
          headers: { authorization: "raw-headers" },
          cause: { token: "raw-cause" },
        },
      );
      error.stack =
        "Error https://user:pass@admin.example.invalid/app.js?token=secret#credential lyxm_secret eyJfoo.bar.baz";
      reporter.capture(error, "error");
    });
    await received;
    const lines = sent.split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({
      event_id: UUID.replaceAll("-", ""),
      sent_at: "2026-10-01T00:00:00.000Z",
      dsn: DSN,
    });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
    const event = eventOf(sent);
    expect(event).toMatchObject({
      level: "error",
      platform: "javascript",
      release: BUILD,
      user: { id: USER_ID },
      tags: { kind: "error", clientPlatform: "web" },
    });
    for (const text of [
      "13800138000",
      "91430100MA4L12345X",
      "lyxa_secret",
      "lyxm_secret",
      "tokenvalue",
      "raw-password",
      "raw-body",
      "raw-headers",
      "raw-cause",
      "user:pass",
      "?token=",
      "#credential",
      "eyJfoo.bar.baz",
    ])
      expect(sent).not.toContain(text);
    expect(event.request).toBeUndefined();
    expect(event.exception.values[0].stack).toContain("https://admin.example.invalid/app.js");
  });

  it("未知object/rejection只取自身安全message，不串行化任意body或触发getter", () => {
    const getter = vi.fn(() => {
      throw new Error("getter side effect");
    });
    const reason = { body: "raw-body", token: "raw-token", toJSON: getter };
    Object.defineProperty(reason, "message", { get: getter });
    const { reporter, sender } = setup();
    reporter.capture(reason, "unhandledrejection");
    expect(getter).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(eventOf(sender.mock.calls[0]![0]).exception.values[0]).toEqual({
      type: "Error",
      value: "Unknown error",
    });
    expect(sender.mock.calls[0]![0]).not.toMatch(/raw-body|raw-token/);
  });

  it("只保留内部UUID用户id，敏感或匿名id都不发送user；所有文本限制2000", async () => {
    const { reporter, sender } = setup({
      build: "x".repeat(3_000),
      getUserId: () => "13800138000",
    });
    const error = new Error("中".repeat(3_000));
    error.name = "n".repeat(3_000);
    error.stack = "s".repeat(3_000);
    reporter.capture(error);
    const event = eventOf(sender.mock.calls[0]![0]);
    expect(event.user).toBeUndefined();
    expect(event.release).toHaveLength(2_000);
    expect(event.exception.values[0].type).toHaveLength(2_000);
    expect(event.exception.values[0].value).toHaveLength(2_000);
    expect(event.exception.values[0].stack).toHaveLength(2_000);
    await flush();
  });

  it.each([
    "",
    "http://key@errors.example.invalid/42",
    "https://key:secret@errors.example.invalid/42",
    `${DSN}?credential=secret`,
    `${DSN}#secret`,
    "https://key@errors.example.invalid/not-project",
  ])("未配置/不合法DSN完全不收集、不请求：%s", (dsn) => {
    const uuid = vi.fn();
    const now = vi.fn();
    const getUserId = vi.fn();
    const { reporter, sender } = setup({ dsn, uuid, now, getUserId });
    reporter.capture(new Error("private"));
    expect(sender).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(getUserId).not.toHaveBeenCalled();
  });
});

describe("后台报告限量、去重与失败旁路", () => {
  it("每分钟10条、59,999ms还限流、60,000ms恢复；同session错误仍只一次", async () => {
    let at = Date.parse("2026-10-01T00:00:00Z");
    const { reporter, sender } = setup({ now: () => at });
    for (let n = 0; n < 10; n += 1) {
      reporter.capture(`error-${n}`);
      await flush();
    }
    reporter.capture("drop-11");
    expect(sender).toHaveBeenCalledTimes(10);
    at += 59_999;
    reporter.capture("drop-before-boundary");
    expect(sender).toHaveBeenCalledTimes(10);
    at += 1;
    reporter.capture("error-0");
    expect(sender).toHaveBeenCalledTimes(10);
    reporter.capture("after-boundary");
    expect(sender).toHaveBeenCalledTimes(11);
  });

  it("清洗后fingerprint去重，原始敏感文本差异不存session集合", async () => {
    const { reporter, sender } = setup();
    reporter.capture("phone 13800138000 token lyxa_first");
    await flush();
    reporter.capture("phone 13900139000 token lyxa_second");
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("sender在途最多2，不建立客户端队列；settle后新错误可发送", async () => {
    const finish: (() => void)[] = [];
    const sender = vi.fn<(raw: string) => Promise<unknown>>(
      () => new Promise<void>((resolve) => finish.push(resolve)),
    );
    const { reporter } = setup({ sender });
    reporter.capture("one");
    reporter.capture("two");
    reporter.capture("third");
    expect(sender).toHaveBeenCalledTimes(2);
    finish[0]!();
    await flush();
    reporter.capture("third");
    expect(sender).toHaveBeenCalledTimes(3);
    finish[1]!();
    finish[2]!();
    await flush();
  });

  it("同session最多1000个有限fingerprint，此后新错误受控丢弃", async () => {
    let at = 0;
    const { reporter, sender } = setup({ now: () => at });
    for (let n = 0; n < 1_001; n += 1) {
      at = n * 60_000;
      reporter.capture(`different-${n}`);
      await flush();
    }
    expect(sender).toHaveBeenCalledTimes(1_000);
  });

  it("sender同步抛错/Promise拒绝/重入都不抛出或递归，新业务错误之后仍可报", async () => {
    const sender = vi.fn<(raw: string) => Promise<unknown>>();
    const { reporter } = setup({ sender });
    sender.mockImplementationOnce(() => {
      reporter.capture("reporter failure", "api");
      throw new Error("fictional network failure");
    });
    expect(() => reporter.capture("business-one")).not.toThrow();
    expect(sender).toHaveBeenCalledTimes(1);
    sender.mockRejectedValueOnce(new Error("fictional send rejection"));
    reporter.capture("business-two");
    await flush();
    expect(sender).toHaveBeenCalledTimes(2);
    sender.mockResolvedValueOnce(undefined);
    reporter.capture("business-three");
    await flush();
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("actual centralAPI网络失败被reporter处理，不产生新的unhandledrejection或再发信封", async () => {
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockRejectedValue(new Error("fictional network failed"));
    const api = createAdminApi({
      build: BUILD,
      baseUrl: "https://admin.example.invalid",
      handlers: handlers(),
      fetch,
    });
    const { reporter } = setup({ sender: createAdminClientErrorSender(api.client) });
    const received = vi.fn();
    process.on("unhandledRejection", received);
    try {
      reporter.capture(new Error("business failure"));
      // 中央API有多层Promise，给本event loop结清自己的拒绝链，不靠sleep。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(received).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", received);
    }
  });
});

describe("真实 EventTarget 的浏览器钩子生命周期", () => {
  it("监听error/unhandledrejection；重复安装只一组监听，逐个幂等解绑，重装仍可用", async () => {
    const window = new EventTarget() as unknown as Window;
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { reporter, sender } = setup();
    const first = reporter.install(window);
    const second = reporter.install(window);
    expect(add).toHaveBeenCalledTimes(2);
    const error = new Event("error");
    Object.defineProperty(error, "error", { value: new Error("window error") });
    window.dispatchEvent(error);
    await flush();
    const rejected = new Event("unhandledrejection");
    Object.defineProperty(rejected, "reason", { value: "unhandled reason" });
    window.dispatchEvent(rejected);
    await flush();
    expect(sender).toHaveBeenCalledTimes(2);
    expect(eventOf(sender.mock.calls[0]![0]).tags.kind).toBe("error");
    expect(eventOf(sender.mock.calls[1]![0]).tags.kind).toBe("unhandledrejection");
    first();
    first();
    expect(remove).not.toHaveBeenCalled();
    second();
    second();
    expect(remove).toHaveBeenCalledTimes(2);
    const after = new Event("error");
    Object.defineProperty(after, "message", { value: "after uninstall" });
    window.dispatchEvent(after);
    expect(sender).toHaveBeenCalledTimes(2);
    const reinstalled = reporter.install(window);
    window.dispatchEvent(after);
    await flush();
    expect(sender).toHaveBeenCalledTimes(3);
    reinstalled();
    expect(remove).toHaveBeenCalledTimes(4);
  });

  it("未配置不安装浏览器监听，不阻止默认浏览器错误处理", () => {
    const window = new EventTarget() as unknown as Window;
    const add = vi.spyOn(window, "addEventListener");
    const { reporter, sender } = setup({ dsn: "" });
    const off = reporter.install(window);
    off();
    off();
    expect(add).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });
});
