import { describe, expect, it, vi } from "vitest";

import { failure, ok, SESSION } from "./api.test-helpers";
import { createPortalRuntime } from "./runtime";

const reporting = {
  dsn: "https://fictionalpublic@errors.example.invalid/42",
  build: "7f18e559ecbcc1d552d4df59857173a6d54b5e65",
  origin: "https://portal.example.invalid",
};
const flush = async () => {
  for (let n = 0; n < 12; n += 1) await Promise.resolve();
};

describe("Portal runtime正式错误writer装配", () => {
  it("默认runtime不发送；业务网络失败仍仅一次原请求", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("private raw transport"));
    const runtime = createPortalRuntime({ fetch: send });
    runtime.clientReporting.capture(new Error("private exception"));
    runtime.clientReporting.report({ category: "api", status: 500 });
    expect(send).not.toHaveBeenCalled();
    await expect(
      runtime.client.request("/api/v1/portal/sessions/current", "get", {}),
    ).rejects.toMatchObject({ error: "NETWORK_ERROR" });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("正式API 404/网络/非法响应只各报告一次，自身上报失败没有递归", async () => {
    let business = 0;
    const send = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === "/api/v1/portal/client-errors") throw new Error("private report failure");
      business += 1;
      if (business === 1) return failure("NOT_FOUND", 404);
      if (business === 2) throw new Error("private query");
      return new Response("not-json", { status: 200 });
    });
    const runtime = createPortalRuntime({ fetch: send, reporting });
    for (const error of ["NOT_FOUND", "NETWORK_ERROR", "INVALID_RESPONSE"]) {
      await expect(
        runtime.client.request("/api/v1/portal/sessions/current", "get", {}),
      ).rejects.toMatchObject({ error });
      await flush();
    }
    const reports = send.mock.calls.filter(([path]) => path === "/api/v1/portal/client-errors");
    expect(reports).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(6);
    expect(
      reports.map(([, init]) => JSON.parse(String(init?.body).split("\n")[2]!).tags.kind),
    ).toEqual(["not_found", "network", "api"]);
    expect(JSON.stringify(reports)).not.toContain("private");
    runtime.dispose();
  });

  it("上报429/维护不清除唯一真实会话、不冷却业务；换身份不携带旧token或业务字段", async () => {
    let reportCount = 0,
      currentCount = 0;
    const send = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === "/api/v1/portal/client-errors") {
        reportCount += 1;
        return reportCount === 1
          ? failure("RATE_LIMITED", 429, {}, { "Retry-After": "60" })
          : failure("MAINTENANCE", 503);
      }
      currentCount += 1;
      return ok({
        ...SESSION,
        storeId: currentCount === 1 ? SESSION.storeId : "019a4500-0000-7000-8000-000000000099",
      });
    });
    const runtime = createPortalRuntime({
      fetch: send,
      reporting,
      now: () => Date.parse(SESSION.serverTime),
    });
    await runtime.session.load();
    const before = runtime.session.getSnapshot();
    expect(before.status).toBe("authenticated");
    runtime.clientReporting.report({
      category: "api",
      status: 500,
      pollSecret: "private-old-token",
      user: SESSION,
    });
    await flush();
    expect(runtime.session.getSnapshot()).toBe(before);
    await runtime.session.load();
    expect(runtime.session.getSnapshot().status).toBe("authenticated");
    expect(runtime.session.getSnapshot().scope).not.toBe(before.scope);
    runtime.clientReporting.report({
      category: "api",
      status: 501,
      body: "private-new-body",
      user: SESSION,
    });
    await flush();
    await runtime.session.load();
    expect(runtime.session.getSnapshot().status).toBe("authenticated");
    expect(currentCount).toBe(3);
    expect(reportCount).toBe(2);
    for (const [, init] of send.mock.calls.filter(
      ([path]) => path === "/api/v1/portal/client-errors",
    )) {
      expect(String(init?.body)).not.toMatch(
        /private|测试门店|测试主体|138|portalSessionId|storeId|entityId/,
      );
      const headers = new Headers(init?.headers);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Cookie")).toBe(false);
    }
    runtime.dispose();
    runtime.dispose();
    runtime.clientReporting.capture(new Error("after disposal"));
    await expect(
      runtime.client.request("/api/v1/portal/sessions/current", "get", {}),
    ).rejects.toMatchObject({ error: "CLIENT_DISPOSED" });
    expect(send).toHaveBeenCalledTimes(5);
  });
});
