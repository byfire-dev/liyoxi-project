import { describe, expect, it, vi } from "vitest";
import { createPortalClient } from "../../lib/api";
import { createPortalRuntime } from "../../lib/runtime";
import { deferred, failure, ok } from "../../lib/api.test-helpers";
import { createVerificationApi } from "./api";
import { createVerificationModel } from "./model";
import { VERIFICATION } from "./test-helpers";

describe("W6-12 匿名验真传输与读取", () => {
  it("raw rev逐字映射revNo，无Number/trim/default；只有固定公开GET", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => ok(VERIFICATION));
    const client = createPortalClient({ fetch: send }),
      api = createVerificationApi(client);
    for (const raw of [
      null,
      "",
      "abc",
      "1x",
      "1.5",
      "0",
      "-1",
      "Infinity",
      "1e2",
      " 1 ",
      "9007199254740992",
      "0002",
      "2",
      "1",
      "999",
    ]) {
      await api.get("PublicCode123456", raw);
      const [path, options] = send.mock.calls.at(-1)!;
      const url = new URL(String(path), "https://portal.example.invalid");
      expect(url.pathname).toBe("/api/v1/portal/license-verifications");
      expect(url.searchParams.get("code")).toBe("PublicCode123456");
      expect(url.searchParams.get("revNo")).toBe(raw);
      expect(url.searchParams.has("rev")).toBe(false);
      expect(options?.method).toBe("GET");
      expect(options?.cache).toBe("no-store");
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
    }
    expect(send).toHaveBeenCalledTimes(15);
    client.dispose();
  });

  it("显式公开投影排除额外内部字段，不把code或查询参数放入模型快照", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      ok({
        ...VERIFICATION,
        fileId: "private-file-sentinel",
        entityId: "private-entity-sentinel",
        pdfUrl: "https://private.example.invalid/sentinel",
        verifyCode: "secret-code-sentinel",
        account: { ...VERIFICATION.account, phone: "private-phone-sentinel" },
        currentRevision: { ...VERIFICATION.currentRevision, privateKey: "private-key-sentinel" },
      }),
    );
    const client = createPortalClient({ fetch: send }),
      model = createVerificationModel(client);
    await model.lookup("PublicCode123456", "2");
    expect(model.getSnapshot().value).toEqual(VERIFICATION);
    expect(JSON.stringify(model.getSnapshot())).not.toMatch(/sentinel|PublicCode123456|https:/);
    expect(send).toHaveBeenCalledOnce();
    model.dispose();
    client.dispose();
  });

  it("无code只显示输入，切查询废弃旧响应；404不保留上一份授权内容", async () => {
    const send = vi.fn<typeof fetch>(),
      client = createPortalClient({ fetch: send });
    const model = createVerificationModel(client);
    await model.lookup("");
    expect(send).not.toHaveBeenCalled();
    expect(model.getSnapshot().status).toBe("input");
    const old = deferred<Response>();
    send
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(ok({ ...VERIFICATION, letterNo: "NEW" }));
    const pending = model.lookup("OLD");
    await model.lookup("NEW");
    old.resolve(ok(VERIFICATION));
    await pending;
    expect(model.getSnapshot().value?.letterNo).toBe("NEW");
    send.mockResolvedValueOnce(failure("LICENSE_VERIFICATION_NOT_FOUND", 404));
    await model.lookup("bad-code");
    expect(model.getSnapshot().value).toBeNull();
    expect(model.getSnapshot().error?.error).toBe("LICENSE_VERIFICATION_NOT_FOUND");
    model.dispose();
    client.dispose();
  });

  it("public读取不依赖session；共享会话失效不取消匿名验真或产生登录请求", async () => {
    const reply = deferred<Response>(),
      send = vi.fn<typeof fetch>().mockReturnValueOnce(reply.promise);
    const runtime = createPortalRuntime({ fetch: send }),
      model = createVerificationModel(runtime.client);
    const pending = model.lookup("PublicCode123456");
    runtime.session.invalidate();
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    reply.resolve(ok(VERIFICATION));
    await pending;
    expect(model.getSnapshot().status).toBe("ready");
    expect(send).toHaveBeenCalledOnce();
    model.dispose();
    runtime.dispose();
  });

  it("429遵守真实冷却但不轮询；维护和上游错误不保原文，也不触发写操作", async () => {
    let now = 1000;
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(failure("RATE_LIMITED", 429, {}, { "Retry-After": "5" }));
    const client = createPortalClient({ fetch: send, now: () => now }),
      model = createVerificationModel(client, { now: () => now });
    await model.lookup("PublicCode123456");
    await model.refresh();
    expect(send).toHaveBeenCalledOnce();
    now += 5000;
    expect(send).toHaveBeenCalledOnce();
    send.mockResolvedValueOnce(failure("MAINTENANCE", 503));
    await model.refresh();
    expect(model.getSnapshot().error?.error).toBe("MAINTENANCE");
    expect(model.getSnapshot().error?.message).not.toContain("不信任的服务端原文");
    await model.refresh();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    model.dispose();
    client.dispose();
  });

  it("离页中断在途查询，迟到成功不得保留证明或恢复页面", async () => {
    const reply = deferred<Response>(),
      send = vi.fn<typeof fetch>().mockReturnValueOnce(reply.promise);
    const client = createPortalClient({ fetch: send }),
      model = createVerificationModel(client);
    const pending = model.lookup("PublicCode123456", "1");
    model.dispose();
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    reply.resolve(ok(VERIFICATION));
    await pending;
    expect(model.getSnapshot().value).toBeNull();
    client.dispose();
  });
});
