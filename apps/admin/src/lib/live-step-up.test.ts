import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveStepUp } from "../../test/e2e/live-step-up";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  vi.restoreAllMocks();
});
const page = (session = "session-one") => ({
  context: () => ({ cookies: async () => [{ name: "sid", value: session }] }),
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lyx-live-step-up-"));
  directories.push(directory);
  const file = join(directory, "context.json");
  const origin = "http://127.0.0.1:4183";
  const codes = ["AAAAA-00001", "AAAAA-00002", "AAAAA-00003"];
  writeFileSync(
    file,
    JSON.stringify({ origin, stepUp: { staffId: "administrator", recoveryCodes: codes } }),
    { mode: 0o644 },
  );
  const remaining = () =>
    (JSON.parse(readFileSync(file, "utf8")) as { stepUp: { recoveryCodes: string[] } }).stepUp
      .recoveryCodes;
  const now = "2026-10-18T06:02:00.000Z";
  const sessions = new Map([
    ["session-one", { staffId: "administrator", until: "2026-10-18T06:01:00.000Z" }],
    ["session-two", { staffId: "administrator", until: "2026-10-18T06:01:00.000Z" }],
    ["personal", { staffId: "editor", until: "2026-10-18T06:12:00.000Z" }],
  ]);
  const attempts: { session: string; code: string }[] = [];
  let beforeVerify: () => void = () => {};
  let receiptSession: string | undefined;
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const session = new Headers(init?.headers).get("Cookie")!.slice("sid=".length);
    const current = sessions.get(session)!;
    if (url.endsWith("/auth/me"))
      return Response.json({
        data: {
          staff: { staffId: current.staffId },
          session: { staffSessionId: receiptSession ?? session, stepUpValidUntil: current.until },
          serverTime: now,
        },
      });
    expect(url).toBe(`${origin}/api/v1/admin/auth/step-up`);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { method: string; code: string };
    expect(body.method).toBe("recovery");
    attempts.push({ session, code: body.code });
    beforeVerify();
    current.until = "2026-10-18T06:12:00.000Z";
    return Response.json({ data: { stepUpValidUntil: current.until } });
  });
  const helper = createLiveStepUp({ contextFile: () => file, fetch: transport });
  return {
    ...helper,
    file,
    codes,
    remaining,
    sessions,
    attempts,
    transport,
    beforeVerify(callback: () => void) {
      beforeVerify = callback;
    },
    replaceSessionReceipt(value: string) {
      receiptSession = value;
    },
  };
}
const response = (status: number, error?: string) => ({
  status: () => status,
  json: async () => ({ error }),
});

describe("live 真实再验证的单 worker 交接", () => {
  it("以 me 服务端时间判断有效期，不使用宿主时钟或消费新鲜会话的恢复码", async () => {
    const f = fixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
    f.sessions.get("session-one")!.until = "2026-10-18T06:12:00.000Z";
    await f.ensure(page());
    expect(f.attempts).toEqual([]);
    expect(f.remaining()).toEqual(f.codes);
  });

  it("已过期及临近提交边界的会话先真实验证，消费先落盘且权限为 0600", async () => {
    const f = fixture();
    f.beforeVerify(() => {
      expect(f.remaining()).not.toContain(f.attempts.at(-1)!.code);
      expect(statSync(f.file).mode & 0o777).toBe(0o600);
    });
    await f.ensure(page());
    f.sessions.get("session-one")!.until = "2026-10-18T06:02:05.000Z";
    await f.ensure(page());
    expect(f.attempts.map((attempt) => attempt.code)).toEqual(f.codes.slice(0, 2));
    expect(f.remaining()).toEqual(f.codes.slice(2));
  });

  it("网络失败不复用已消费码，队列失败后仍可用下一枚真实验证", async () => {
    const f = fixture();
    f.beforeVerify(() => {
      throw new Error("synthetic network failure");
    });
    await expect(f.ensure(page())).rejects.toThrow("synthetic network failure");
    expect(f.remaining()).toEqual(f.codes.slice(1));
    f.beforeVerify(() => {});
    await f.ensure(page());
    expect(f.attempts.map((attempt) => attempt.code)).toEqual(f.codes.slice(0, 2));
  });

  it("不同 Page 共用实际 session 时串行重读回执，只消费一枚码", async () => {
    const f = fixture();
    await Promise.all([f.ensure(page()), f.ensure(page())]);
    expect(f.attempts).toEqual([{ session: "session-one", code: f.codes[0] }]);
    expect(f.transport.mock.calls.filter(([url]) => String(url).endsWith("/auth/me"))).toHaveLength(
      3,
    );
  });

  it("不同实际 session 各自验证；其他身份不能消费本轮管理员的恢复码", async () => {
    const f = fixture();
    await expect(f.ensure(page("personal"), true)).rejects.toThrow("不是本轮恢复码所属管理员");
    expect(f.remaining()).toEqual(f.codes);
    await Promise.all([f.ensure(page()), f.ensure(page("session-two"))]);
    expect(f.attempts).toEqual([
      { session: "session-one", code: f.codes[0] },
      { session: "session-two", code: f.codes[1] },
    ]);
  });

  it("强制场景即使新鲜也执行真实 step-up，并检查同一会话的有效回执", async () => {
    const f = fixture();
    f.sessions.get("session-one")!.until = "2026-10-18T06:12:00.000Z";
    await f.ensure(page(), true);
    expect(f.attempts).toHaveLength(1);
    f.beforeVerify(() => {
      f.sessions.get("session-one")!.staffId = "other-administrator";
    });
    await expect(f.ensure(page(), true)).rejects.toThrow("不是本轮恢复码所属管理员");
  });

  it("成功 HTTP 但回执属于其他 session 时仍失败，不把验证成功缓存到当前会话", async () => {
    const f = fixture();
    f.beforeVerify(() => f.replaceSessionReceipt("changed-session"));
    await expect(f.ensure(page())).rejects.toThrow("未读到原会话的有效回执");
    expect(f.remaining()).toEqual(f.codes.slice(1));
  });

  it("只在精确 403 STEP_UP_REQUIRED 后真实再验证并最多重放一次，原请求不变", async () => {
    const f = fixture();
    f.sessions.get("session-one")!.until = "2026-10-18T06:12:00.000Z";
    const original = { headers: { "Idempotency-Key": "same-original-intent" }, data: { id: 1 } };
    const requests: (typeof original)[] = [];
    const send = vi.fn(async () => {
      requests.push(original);
      return response(403, "STEP_UP_REQUIRED");
    });
    expect((await f.write(page(), send)).status()).toBe(403);
    expect(send).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([original, original]);
    expect(requests[0]).toBe(requests[1]);
    expect(f.attempts).toHaveLength(1);
  });

  it("普通拒绝或其他状态不重放，也不消费恢复码", async () => {
    const f = fixture();
    f.sessions.get("session-one")!.until = "2026-10-18T06:12:00.000Z";
    for (const result of [
      response(403, "PERMISSION_DENIED"),
      response(403, "UNKNOWN_ERROR"),
      response(500, "STEP_UP_REQUIRED"),
    ]) {
      const send = vi.fn(async () => result);
      expect(await f.write(page(), send)).toBe(result);
      expect(send).toHaveBeenCalledTimes(1);
    }
    expect(f.attempts).toEqual([]);
    expect(f.remaining()).toEqual(f.codes);
  });
});
