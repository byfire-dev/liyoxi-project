import { describe, expect, it, vi } from "vitest";

import { createPortalClient, type PortalPath } from "./api";
import { PortalApiError } from "./api-errors";
import { deferred, failure, ok } from "./api.test-helpers";

describe("portal 同源 typed transport", () => {
  it("相对路径、Cookie/no-store、写入CSRF与none单次发送，不自造Origin或幂等键", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(ok(null));
    const client = createPortalClient({ fetch: send });
    await client.request("/api/v1/portal/sessions/current", "delete", {});
    expect(send).toHaveBeenCalledTimes(1);
    const [url, options] = send.mock.calls[0]!;
    expect(url).toBe("/api/v1/portal/sessions/current");
    expect(options).toMatchObject({
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("X-LYX-Portal")).toBe("1");
    for (const key of ["Origin", "Authorization", "Cookie", "Idempotency-Key", "X-Store-Id"])
      expect(headers.has(key)).toBe(false);
  });

  it.each([
    "https://other.invalid/api/v1/portal/sessions/current",
    "//other.invalid/x",
    "/api/v1/portal/../m/foo",
    "/api/v1/portal/\\evil",
    "/api/v1/portal/sessions/current?origin=evil",
  ])("外域或路径注入在发送前拒绝：%s", async (path) => {
    const send = vi.fn<typeof fetch>();
    const client = createPortalClient({ fetch: send });
    await expect(client.request(path as PortalPath, "get", {} as never)).rejects.toMatchObject({
      error: "INVALID_REQUEST",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("合法 query 编码且 per-request 序列化不误归一化公开验真rev", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => ok(null));
    const client = createPortalClient({ fetch: send });
    await client.request("/api/v1/portal/license-verifications", "get", {
      query: { code: "A+B" },
      querySerializer: ({ code }) => new URLSearchParams({ code, revNo: "1e2" }),
    });
    expect(send.mock.calls[0]?.[0]).toBe(
      "/api/v1/portal/license-verifications?code=A%2BB&revNo=1e2",
    );
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).has("X-LYX-Portal")).toBe(false);
    await expect(
      client.request("/api/v1/portal/license-verifications", "get", {
        query: { code: "public" },
        querySerializer: () => new URLSearchParams({ pollSecret: "forbidden" }),
      }),
    ).rejects.toMatchObject({ error: "INVALID_REQUEST" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Sentry raw信封保持原字节，202/null合法且没有自动发送器", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(ok(null, 202));
    const client = createPortalClient({ fetch: send });
    expect(send).not.toHaveBeenCalled();
    const envelope = '{}\n{"type":"event"}\n{}';
    await expect(
      client.request("/api/v1/portal/client-errors", "post", { body: envelope }),
    ).resolves.toBeNull();
    expect(send.mock.calls[0]?.[1]?.body).toBe(envelope);
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get("Content-Type")).toBe(
      "application/x-sentry-envelope",
    );
  });

  it("失败错误有界投影，不保留消息、秘密、签名URL、headers/body/cause", async () => {
    const secret = "private-auth-material-should-never-be-recorded";
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      failure("VALIDATION_FAILED", 400, {
        message: secret,
        details: {
          secret,
          url: "https://private.invalid",
          currentVersionNo: 2,
          expiresAt: "2026-11-04T00:00:00.000Z",
          reason: "expired",
        },
        fieldErrors: [
          { path: "versionNo", message: secret },
          { path: "pollSecret", message: secret },
        ],
      }),
    );
    const client = createPortalClient({ fetch: send });
    const caught = await client
      .request("/api/v1/portal/sessions/current", "get", {})
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(PortalApiError);
    expect(caught).toMatchObject({
      status: 400,
      details: { currentVersionNo: 2, reason: "expired", expiresAt: "2026-11-04T00:00:00.000Z" },
      fieldErrors: [{ path: "versionNo", message: "请检查该字段" }],
    });
    expect(JSON.stringify(caught)).not.toMatch(
      /private-auth|private.invalid|pollSecret|cause|headers/,
    );
    expect(String(caught)).not.toContain(secret);
  });

  it("429遵守Retry-After，写失败不自动重试；维护后不再请求", async () => {
    let time = 1000;
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(failure("RATE_LIMITED", 429, {}, { "Retry-After": "2" }))
      .mockResolvedValueOnce(failure("MAINTENANCE", 503));
    const client = createPortalClient({ fetch: send, now: () => time });
    const call = () => client.request("/api/v1/portal/sessions/current", "delete", {});
    await expect(call()).rejects.toMatchObject({ error: "RATE_LIMITED", retryAfter: 2 });
    await expect(call()).rejects.toMatchObject({ error: "RATE_LIMITED" });
    expect(send).toHaveBeenCalledTimes(1);
    time = 3000;
    await expect(call()).rejects.toMatchObject({ error: "MAINTENANCE" });
    time = 99_000;
    await expect(call()).rejects.toMatchObject({ error: "MAINTENANCE" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("scope变化会终止旧请求，即使传输忽略Abort也不能返回旧数据", async () => {
    const delayed = deferred<Response>();
    const send = vi.fn<typeof fetch>().mockReturnValue(delayed.promise);
    const client = createPortalClient({ fetch: send });
    const work = client.request("/api/v1/portal/sessions/current", "get", {});
    client.advanceScope();
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    delayed.resolve(ok({ obsolete: true }));
    await expect(work).rejects.toMatchObject({ error: "REQUEST_ABORTED" });
  });

  it("网络错误不带原异常内容，dispose终止全部请求且不可复用", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("https://private.invalid/?pollSecret=leak"));
    const client = createPortalClient({ fetch: send });
    const caught = await client
      .request("/api/v1/portal/sessions/current", "get", {})
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({ error: "NETWORK_ERROR" });
    expect(caught).not.toHaveProperty("cause");
    client.dispose();
    await expect(
      client.request("/api/v1/portal/sessions/current", "get", {}),
    ).rejects.toMatchObject({ error: "CLIENT_DISPOSED" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("非JSON的401仍触发真实失效，成功响应缺少合法envelope则拒绝", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("untrusted", { status: 401 }))
      .mockResolvedValueOnce(new Response("untrusted", { status: 200 }));
    const client = createPortalClient({ fetch: send });
    const listener = vi.fn();
    client.subscribeErrors(listener);
    await expect(
      client.request("/api/v1/portal/sessions/current", "get", {}),
    ).rejects.toMatchObject({ error: "AUTH_REQUIRED", status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(
      client.request("/api/v1/portal/sessions/current", "get", {}),
    ).rejects.toMatchObject({ error: "INVALID_RESPONSE" });
  });
});
