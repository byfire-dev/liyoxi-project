import { EventEmitter } from "node:events";
import type * as NodeTls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../testing/index.js";
import { failed, ok } from "../providers/types.js";
import { createCertChecker, probeTlsCertificate } from "./cert.js";
import type { TlsCertificateProbe } from "./cert.js";

const tls = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof NodeTls>()),
  connect: tls.connect,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const clock = createClock(new Date("2026-10-13T01:00:00Z"));
const expires = (days: number) => new Date(clock.now().getTime() + days * 86_400_000);
const validFrom = expires(-30);
function socketFixture(
  options: { trusted?: boolean; name?: string; valid_to?: string; valid_from?: string } = {},
) {
  const socket = Object.assign(new EventEmitter(), {
    authorized: options.trusted ?? true,
    getPeerCertificate: () => ({
      subjectaltname: `DNS:${options.name ?? "api.example.invalid"}`,
      valid_to: options.valid_to ?? expires(30).toUTCString(),
      valid_from: options.valid_from ?? validFrom.toUTCString(),
    }),
    destroy: vi.fn(),
  });
  tls.connect.mockReturnValue(socket);
  return socket;
}
describe("显式部署证书检查", () => {
  it("空配置零网络；拒绝非域名、超量与无界超时；域名按小写去重", async () => {
    const probe = vi.fn<TlsCertificateProbe>(async () =>
      ok({ expiresAt: expires(30), validFrom, trusted: true }),
    );
    expect(await createCertChecker({ clock, domains: [], probe }).run()).toEqual({
      configured: false,
      certificates: [],
    });
    expect(probe).not.toHaveBeenCalled();
    for (const domain of [
      "https://example.invalid",
      "localhost",
      "1.2.3.4",
      "a.example.invalid:443",
      "*.example.invalid",
    ])
      expect(() => createCertChecker({ clock, domains: [domain] })).toThrow("显式DNS域名");
    expect(() => createCertChecker({ clock, domains: [], timeoutMs: 2001 })).toThrow();
    await createCertChecker({
      clock,
      domains: ["API.example.invalid", "api.example.invalid"],
      probe,
    }).run();
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("21/7天严格边界、过期、信任/未生效/无效日期与不可达均保留真实状态", async () => {
    const replies: Array<Awaited<ReturnType<TlsCertificateProbe>>> = [
      ...[21, 20.99, 7, 6.99, -1].map((days) =>
        ok({ expiresAt: expires(days), validFrom, trusted: true }),
      ),
      ok({ expiresAt: expires(30), validFrom, trusted: false }),
      ok({ expiresAt: expires(30), validFrom: expires(1), trusted: true }),
      ok({ expiresAt: new Date(NaN), validFrom, trusted: true }),
      failed("unavailable", "连接失败"),
    ];
    const probe = vi.fn<TlsCertificateProbe>(async () => replies.shift()!);
    const result = await createCertChecker({
      clock,
      domains: Array.from({ length: 9 }, (_, n) => `a${n}.example.invalid`),
      probe,
    }).run();
    expect(result.certificates.map((item) => [item.status, item.priority])).toEqual([
      ["healthy", undefined],
      ["expiring", "P2"],
      ["expiring", "P2"],
      ["expiring", "P1"],
      ["expiring", "P1"],
      ["untrusted", "P1"],
      ["untrusted", "P1"],
      ["unavailable", "P2"],
      ["unavailable", "P2"],
    ]);
  });
  it("替身忽略取消也有界超时，迟到异常被消费，取消后不再查后续域名", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const probe = vi.fn<TlsCertificateProbe>(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = createCertChecker({ clock, domains: ["api.example.invalid"], probe }).run();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).certificates[0]).toMatchObject({
      status: "unavailable",
      priority: "P2",
    });
    reject(new Error("private response"));
    await Promise.resolve();
    const abort = new AbortController();
    const cancelled = createCertChecker({
      clock,
      domains: ["a.example.invalid", "b.example.invalid"],
      probe,
    }).run({ signal: abort.signal });
    const outcome = expect(cancelled).rejects.toThrow();
    await Promise.resolve();
    abort.abort(new Error("stop"));
    await outcome;
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("原生TLS固定443/SNI，真实读日期且同时核链信任和域名，成功释放socket", async () => {
    for (const options of [{}, { trusted: false }, { name: "wrong.example.invalid" }]) {
      const socket = socketFixture(options);
      const result = probeTlsCertificate("api.example.invalid", {
        signal: new AbortController().signal,
        timeoutMs: 2_000,
      });
      socket.emit("secureConnect");
      expect(await result).toMatchObject({
        ok: true,
        value: { expiresAt: expires(30), validFrom, trusted: Object.keys(options).length === 0 },
      });
      expect(socket.destroy).toHaveBeenCalledOnce();
    }
    expect(tls.connect).toHaveBeenLastCalledWith({
      host: "api.example.invalid",
      servername: "api.example.invalid",
      port: 443,
      rejectUnauthorized: false,
    });
  });
  it("原生TLS超时/取消/坏日期均收尾一次，迟到事件不改结果，不输出异常正文", async () => {
    vi.useFakeTimers();
    const socket = socketFixture();
    const pending = probeTlsCertificate("api.example.invalid", {
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    socket.emit("secureConnect");
    socket.emit("error", new Error("private response"));
    expect(socket.destroy).toHaveBeenCalledOnce();
    const aborted = socketFixture(),
      controller = new AbortController();
    const stopping = probeTlsCertificate("api.example.invalid", {
      signal: controller.signal,
      timeoutMs: 2_000,
    });
    controller.abort();
    expect(await stopping).toMatchObject({ ok: false });
    expect(aborted.destroy).toHaveBeenCalledOnce();
    const invalid = socketFixture({ valid_to: "bad" });
    const bad = probeTlsCertificate("api.example.invalid", {
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    });
    invalid.emit("secureConnect");
    expect(await bad).toMatchObject({ ok: false });
  });
});
