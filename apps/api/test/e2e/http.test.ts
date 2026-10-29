import { expect, it, vi } from "vitest";
import {
  assertM1SharedScope,
  createM1HttpStorage,
  createM1RealClock,
  waitM1Due,
} from "@liyoxi/services/testing";
import type { M1Attachment, M1SharedScope } from "@liyoxi/services/testing";
import { createM1HttpTransport, waitM1RealTime } from "./http.js";
import { m1HttpIdentity } from "./http-bridge.js";

const scope: M1SharedScope = {
  runId: "guard123",
  databaseName: "lyx_test_api_guard123_0_m1",
  redisPrefix: "lyx:test:guard123:0:",
  ownerToken: "a".repeat(32),
  startedAt: "2026-10-15T00:00:00.000Z",
};
const attachment: M1Attachment = {
  scope,
  chainId: "round1",
  version: "test-sha",
  storage: {
    endpoint: "http://127.0.0.1:9100",
    region: "us-east-1",
    accessKey: "liyoxi",
    secretKey: "lyx-local-dev",
    buckets: {
      secure: "lyx-test-mixed-guard123-secure",
      asset: "lyx-test-mixed-guard123-asset",
      media: "lyx-test-mixed-guard123-media",
      pub: "lyx-test-mixed-guard123-pub",
    },
  },
};

it("HTTP只发给核验版本的真实目标，保方法/载荷/会话及读请求记录", async () => {
  const requests: { path: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, init });
    return Response.json(path === "/health" ? { version: "test-sha" } : { data: "ok" });
  };
  const transport = await createM1HttpTransport({
    origin: "http://127.0.0.1:8123",
    version: "test-sha",
    fetch,
  });
  const result = await transport.request("/api/v1/admin/staff", {
    method: "POST",
    json: { name: "虚构员工" },
    headers: {
      COOKIE: "owned-test-cookie",
      hOsT: "admin.localhost",
      ORIGIN: "http://admin.localhost",
    },
  });
  expect(result.status).toBe(200);
  expect(requests.map((one) => one.path)).toEqual([
    "/health",
    "/readyz",
    "/health",
    "/api/v1/admin/staff",
  ]);
  expect(requests[3]?.init).toMatchObject({
    method: "POST",
    body: '{"name":"虚构员工"}',
    redirect: "error",
  });
  expect(Object.fromEntries(new Headers(requests[3]?.init?.headers))).toMatchObject({
    host: "127.0.0.1:8123",
    origin: "http://127.0.0.1:8123",
    cookie: "owned-test-cookie",
    "content-type": "application/json",
  });
  expect(requests[3]?.init?.signal).toBeInstanceOf(AbortSignal);
  await transport.request("/api/v1/m/stores");
  expect(transport.observedReads).toEqual(["/api/v1/m/stores"]);
  await transport.request("/api/v1/m/me");
  transport.resetObservedReads();
  expect(transport.observedReads).toEqual([]);
  await transport.request("/api/v1/m/stores");
  await transport.request("/api/v1/m/orders");
  expect(transport.observedReads).toEqual(["/api/v1/m/stores", "/api/v1/m/orders"]);
  for (const original of [
    { Host: "foreign.localhost", Origin: "http://admin.localhost" },
    { Host: "admin.localhost", Origin: "https://foreign.invalid" },
  ]) {
    await transport.request("/api/v1/admin/staff", { method: "POST", headers: original, json: {} });
    const sent = new Headers(requests.at(-1)?.init?.headers);
    expect(sent.get("host")).toBe("127.0.0.1:8123");
    expect(sent.get("origin")).toBe(original.Origin);
  }
  const signedRaw = '{ "id" : "owned-notification", "resource": {"ciphertext":"test"} }';
  await transport.request("/api/v1/hooks/wechatpay/transactions", {
    method: "POST",
    rawBody: signedRaw,
    headers: { "Content-Type": "application/json", "Wechatpay-Signature": "test-signature" },
  });
  expect(requests.at(-1)?.init?.body).toBe(signedRaw);
  expect(new Headers(requests.at(-1)?.init?.headers).get("wechatpay-signature")).toBe(
    "test-signature",
  );
  await expect(
    transport.request("/api/v1/hooks/wechatpay/transactions", {
      method: "POST",
      rawBody: signedRaw,
      json: {},
    }),
  ).rejects.toThrow("正文输入互斥");
  expect(
    requests.filter((request) => request.path === "/api/v1/hooks/wechatpay/transactions"),
  ).toHaveLength(1);
});

it("错版本、越界路径、未知接口和旧版500全部失败关闭，探活响应有界", async () => {
  let actual = "wrong-sha",
    status = 200,
    canceled = false;
  const fetch: typeof globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    return path === "/health" ? Response.json({ version: actual }) : new Response("{}", { status });
  };
  await expect(
    createM1HttpTransport({ origin: "http://remote.invalid", version: "test-sha", fetch }),
  ).rejects.toThrow("本轮本地");
  await expect(
    createM1HttpTransport({ origin: "http://127.0.0.1", version: "test-sha", fetch }),
  ).rejects.toThrow("版本");
  actual = "test-sha";
  const transport = await createM1HttpTransport({
    origin: "http://127.0.0.1",
    version: actual,
    fetch,
  });
  await expect(transport.request("/api/v1/../../../health")).rejects.toThrow("离开");
  await expect(transport.request("https://remote.invalid/api/v1/m/stores")).rejects.toThrow(
    "正式 API",
  );
  for (const code of [404, 500, 503]) {
    status = code;
    await expect(transport.request("/api/v1/m/stores")).rejects.toThrow(`不可用：${code}`);
  }
  expect(transport.observedReads).toEqual([]);
  const huge: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(65 * 1024));
        },
        cancel() {
          canceled = true;
        },
      }),
    );
  await expect(
    createM1HttpTransport({ origin: "http://127.0.0.1", version: actual, fetch: huge }),
  ).rejects.toThrow("过大");
  expect(canceled).toBe(true);
});

it("真实时钟不可拨动，等待拒绝超30秒及取消，不偷换成虚拟推进", async () => {
  const clock = createM1RealClock();
  expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(100);
  expect(() => clock.advance(1)).toThrow("禁止拨动");
  expect(() => clock.set(new Date())).toThrow("禁止拨动");
  for (const wait of [waitM1RealTime, waitM1Due]) {
    await expect(wait(new Date(Date.now() + 31_000))).rejects.toThrow("三十秒");
    await expect(wait(new Date(Number.NaN))).rejects.toThrow();
    await expect(wait(new Date(Date.now() + 5000), AbortSignal.abort())).rejects.toThrow();
    await wait(new Date(Date.now() - 1));
  }
});

it("attach只接精确自有随机库/前缀与公知MinIO，两个轮次身份分别合法且构造零IO", () => {
  assertM1SharedScope(scope);
  for (const changed of [
    { ...scope, databaseName: "lyx_stack" },
    { ...scope, redisPrefix: "lyx:" },
    { ...scope, runId: "../other" },
    { ...scope, ownerToken: "" },
    { ...scope, startedAt: "not-date" },
  ])
    expect(() => assertM1SharedScope(changed)).toThrow("自有随机库");
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    expect(() =>
      createM1HttpStorage({
        ...attachment,
        storage: { ...attachment.storage, endpoint: "https://cloud.invalid" },
      }),
    ).toThrow("本轮本地");
    expect(() =>
      createM1HttpStorage({
        ...attachment,
        storage: { ...attachment.storage, accessKey: "not-public" },
      }),
    ).toThrow("公知测试值");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
  const a = m1HttpIdentity("round1"),
    b = m1HttpIdentity("round2");
  expect(a.merchant.phoneCode).toMatch(/^138\d{8}$/);
  expect(a.reviewerPhone).toMatch(/^199\d{8}$/);
  expect(a.merchant.uscc).toHaveLength(18);
  expect(a.merchant).not.toEqual(b.merchant);
  expect(a.merchant.phoneCode).not.toBe(b.merchant.phoneCode);
  expect(a.reviewerPhone).not.toBe(b.reviewerPhone);
  expect(a.merchant.uscc).not.toBe(b.merchant.uscc);
});
