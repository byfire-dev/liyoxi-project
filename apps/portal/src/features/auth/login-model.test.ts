import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { deferred, ok, SESSION } from "../../lib/api.test-helpers";
import { createPortalLoginModel } from "./login-model";

const SECRET = "login_test_secret_".padEnd(43, "x");
const TICKET = {
  portalTicketId: "019a4500-0000-7000-8000-000000000005",
  qrUrl: "https://portal.example.invalid/a?t=public-id",
  shortCode: "12ABCDEF",
  pairDigits: "17",
  pollSecret: SECRET,
  expiresAt: "2026-11-04T00:02:00.000Z",
  pollIntervalMs: 2000 as const,
};
const status = (value: string) =>
  ok({ portalTicketId: TICKET.portalTicketId, status: value, expiresAt: TICKET.expiresAt });
function setup(send: typeof fetch) {
  const runtime = createPortalRuntime({ fetch: send });
  const authenticated = vi.fn();
  const model = createPortalLoginModel(runtime, { authenticated });
  return {
    runtime,
    model,
    authenticated,
    close: () => {
      model.dispose();
      runtime.dispose();
    },
  };
}

describe("迁移登录叶使用安全壳", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-04T00:00:00Z");
  });
  afterEach(() => vi.useRealTimers());

  it("已授权会话直接进入成片页，不另建票据", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(SESSION));
    const test = setup(send);
    await test.model.start();
    expect(test.authenticated).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain("sessions/current");
    test.close();
  });

  it("2秒串行轮询，交换后读回真实会话才导航，公开状态无secret", async () => {
    const session = deferred<Response>();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(TICKET))
      .mockResolvedValueOnce(status("pending"))
      .mockResolvedValueOnce(status("approved"))
      .mockResolvedValueOnce(ok({ status: "consumed", session: SESSION, rejectReason: null }))
      .mockReturnValueOnce(session.promise);
    const test = setup(send);
    await test.model.start();
    expect(JSON.stringify(test.model.getSnapshot())).not.toContain(SECRET);
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2001);
    expect(send).toHaveBeenCalledTimes(6);
    expect(test.model.getSnapshot().status).toBe("exchanging");
    expect(test.authenticated).not.toHaveBeenCalled();
    session.resolve(ok(SESSION));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.authenticated).toHaveBeenCalledOnce();
    expect(test.model.getSnapshot().ticket).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(6);
    test.close();
  });

  it.each(["rejected", "expired", "consumed"] as const)(
    "%s终态停止，不交换或误登录",
    async (terminal) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ok(null))
        .mockResolvedValueOnce(ok(TICKET))
        .mockResolvedValueOnce(status(terminal));
      const test = setup(send);
      await test.model.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(test.model.getSnapshot().status).toBe(terminal);
      expect(send).toHaveBeenCalledTimes(3);
      expect(test.authenticated).not.toHaveBeenCalled();
      test.close();
    },
  );

  it("刷新废弃旧轮批准响应，离页停止下一轮且中断请求", async () => {
    const stale = deferred<Response>();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(TICKET))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok({ ...TICKET, shortCode: "ZZZZZZZZ" }));
    const test = setup(send);
    await test.model.start();
    await vi.advanceTimersByTimeAsync(2000);
    const oldSignal = send.mock.calls[2]?.[1]?.signal;
    await test.model.start();
    expect(oldSignal?.aborted).toBe(true);
    stale.resolve(status("approved"));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.model.getSnapshot().ticket?.shortCode).toBe("ZZZZZZZZ");
    expect(test.authenticated).not.toHaveBeenCalled();
    test.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("票据本地过期后不再轮询；换码可重新启动", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok({ ...TICKET, expiresAt: "2026-11-04T00:00:01Z" }))
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(TICKET));
    const test = setup(send);
    await test.model.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.model.getSnapshot().status).toBe("expired");
    expect(send).toHaveBeenCalledTimes(2);
    await test.model.start();
    expect(test.model.getSnapshot().status).toBe("pending");
    test.close();
  });

  it("429遵守Retry-After，维护态停止刷新，不绕过安全壳", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "MAINTENANCE" }), { status: 503 }),
      );
    const test = setup(send);
    await test.model.start();
    expect(test.model.getSnapshot().retryAt).toBe(Date.now() + 5000);
    await test.model.start();
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    await test.model.start();
    expect(test.model.getSnapshot().status).toBe("maintenance");
    await test.model.start();
    expect(send).toHaveBeenCalledTimes(3);
    test.close();
  });

  it("Cookie读回失败不把exchange回执当登录成功", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(TICKET))
      .mockResolvedValueOnce(status("approved"))
      .mockResolvedValueOnce(ok({ status: "consumed", session: SESSION, rejectReason: null }))
      .mockResolvedValueOnce(ok(null));
    const test = setup(send);
    await test.model.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.model.getSnapshot().status).toBe("error");
    expect(test.authenticated).not.toHaveBeenCalled();
    test.close();
  });
});
