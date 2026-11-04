import { describe, expect, it, vi } from "vitest";

import { createPortalClient } from "../../lib/api";
import { PortalApiError } from "../../lib/api-errors";
import { deferred, failure, ok, SESSION } from "../../lib/api.test-helpers";
import { createPortalSessionStore } from "./model";

describe("portal session 唯一owner", () => {
  it("创建不请求，current才认证；空响应不当作已登录", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(SESSION));
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    expect(store.getSnapshot().status).toBe("unknown");
    expect(send).not.toHaveBeenCalled();
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ status: "invalid", session: null, scope: null });
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ status: "authenticated", session: SESSION });
    expect(store.captureScope()?.isCurrent()).toBe(true);
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/portal/sessions/current",
      "/api/v1/portal/sessions/current",
    ]);
  });

  it("StrictMode同轮load合并，坏DTO不冒充身份", async () => {
    const wait = deferred<Response>();
    const send = vi.fn<typeof fetch>().mockReturnValue(wait.promise);
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    const first = store.load();
    expect(store.load()).toBe(first);
    wait.resolve(ok({ ...SESSION, grantScope: "entity" }));
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      session: null,
      error: { error: "INVALID_RESPONSE" },
    });
  });

  it("并发401仅清理一次，保存后端失效原因；旧scope与旧响应均作废", async () => {
    const a = deferred<Response>(),
      b = deferred<Response>();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const client = createPortalClient({ fetch: send }),
      store = createPortalSessionStore(client);
    await store.load();
    const old = store.captureScope()!;
    let invalidations = 0;
    store.subscribe(() => {
      if (store.getSnapshot().status === "invalid") invalidations += 1;
    });
    const request = () =>
      client.request("/api/v1/portal/sessions/current", "get", {}).catch((error: unknown) => error);
    const first = request(),
      second = request();
    a.resolve(
      failure("PORTAL_SESSION_INVALID", 401, {
        details: { reason: "revoked", revokeReason: "owner_revoked" },
      }),
    );
    await first;
    b.resolve(failure("PORTAL_SESSION_INVALID", 401, { details: { reason: "expired" } }));
    await second;
    expect(invalidations).toBe(1);
    expect(old.signal.aborted).toBe(true);
    expect(old.isCurrent()).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "invalid",
      session: null,
      error: { details: { reason: "revoked", revokeReason: "owner_revoked" } },
    });
  });

  it("切换授权后A的迟到current不能覆盖B，不能泄漏额外session字段", async () => {
    const oldResponse = deferred<Response>();
    const other = {
      ...SESSION,
      portalSessionId: "019a4500-0000-7000-8000-000000000009",
      storeName: "新授权门店",
    };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(ok({ ...other, token: "discarded" }));
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    await store.load();
    const firstScope = store.captureScope()!;
    const oldLoad = store.load();
    store.invalidate();
    await store.load();
    oldResponse.resolve(ok(SESSION));
    await oldLoad;
    expect(store.getSnapshot().session).toEqual(other);
    expect(store.getSnapshot().scope).not.toBe(firstScope.key);
    expect(firstScope.isCurrent()).toBe(false);
    expect(JSON.stringify(store.getSnapshot())).not.toContain("discarded");
  });

  it("公开请求401不注销已有会话，429保留身份且冷却期不请求", async () => {
    let time = 1000;
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockResolvedValueOnce(failure("AUTH_REQUIRED", 401))
      .mockResolvedValueOnce(failure("RATE_LIMITED", 429, {}, { "Retry-After": "3" }))
      .mockResolvedValueOnce(ok(SESSION));
    const client = createPortalClient({ fetch: send, now: () => time });
    const store = createPortalSessionStore(client, { now: () => time });
    await store.load();
    await expect(
      client.request("/api/v1/portal/license-verifications", "get", {
        query: { code: "public-code" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.getSnapshot().status).toBe("authenticated");
    await store.load();
    expect(store.getSnapshot()).toMatchObject({
      status: "authenticated",
      session: SESSION,
      retryAt: 4000,
    });
    await store.load();
    expect(send).toHaveBeenCalledTimes(3);
    time = 4000;
    await store.load();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("退出网络结果未知保留真实身份并允许显式重试，成功才清空", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockRejectedValueOnce(new Error("private-response"))
      .mockResolvedValueOnce(ok(null));
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    await store.load();
    const scope = store.captureScope()!;
    await store.logout();
    expect(scope.isCurrent()).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "authenticated",
      session: SESSION,
      logoutPending: false,
      error: { error: "NETWORK_ERROR" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    await store.logout();
    expect(store.getSnapshot()).toMatchObject({
      status: "invalid",
      session: null,
      logoutPending: false,
    });
    expect(send.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "DELETE",
      "DELETE",
    ]);
  });

  it("双击退出只发送一次，401视为退出；维护清旧内容且不轮询", async () => {
    const wait = deferred<Response>();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockReturnValueOnce(wait.promise);
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    await store.load();
    const first = store.logout();
    expect(store.logout()).toBe(first);
    expect(store.getSnapshot().logoutPending).toBe(true);
    wait.resolve(failure("PORTAL_SESSION_INVALID", 401, { details: { reason: "expired" } }));
    await first;
    expect(store.getSnapshot()).toMatchObject({
      status: "invalid",
      session: null,
      logoutPending: false,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const paused = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockResolvedValueOnce(failure("MAINTENANCE", 503));
    const pausedStore = createPortalSessionStore(createPortalClient({ fetch: paused }));
    await pausedStore.load();
    const scope = pausedStore.captureScope()!;
    await pausedStore.load();
    expect(pausedStore.getSnapshot()).toMatchObject({ status: "maintenance", session: null });
    expect(scope.isCurrent()).toBe(false);
    await pausedStore.load();
    await pausedStore.logout();
    expect(paused).toHaveBeenCalledTimes(2);
  });

  it("dispose注销监听并废弃异步结果，不复活已离开的owner", async () => {
    const delayed = deferred<Response>();
    const send = vi.fn<typeof fetch>().mockReturnValue(delayed.promise);
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    const listener = vi.fn();
    store.subscribe(listener);
    const work = store.load();
    store.dispose();
    const calls = listener.mock.calls.length;
    delayed.resolve(ok(SESSION));
    await work;
    store.invalidate(new PortalApiError("AUTH_REQUIRED", 401));
    await store.load();
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(store.getSnapshot().session).toBeNull();
    expect(store.captureScope()).toBeNull();
  });
});
