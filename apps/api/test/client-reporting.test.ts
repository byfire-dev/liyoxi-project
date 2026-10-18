// 实际四operation："m.analyticsEvent.batchCreate", "m.subscribeResult.create", "m.clientError.create", "admin.clientError.create"。
import type { AnalyticsIngestResult, Bootstrap } from "@liyoxi/contract";
import { uuidv7 } from "@liyoxi/services";
import { runSeed, SEED_MODULES } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

async function jsonBody<T = unknown>(response: Response): Promise<{ data: T; error?: string }> {
  return (await response.json()) as { data: T; error?: string };
}

const testApi = useTestApi();
let api: TestApi, owner: SignedInMerchant;
const contentType = { "content-type": "application/x-sentry-envelope" };
function envelope(text = "Example error") {
  const eventId = uuidv7().replaceAll("-", "");
  return `${JSON.stringify({ dsn: "https://publickey@example.invalid/7", event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, exception: { values: [{ type: "Error", value: text }] } })}`;
}
function batch() {
  return {
    sentAt: api.clock.now().toISOString(),
    anonymousId: uuidv7(),
    sessionId: uuidv7(),
    clientVersion: "1.0.0",
    platform: "devtools",
    events: [
      {
        eventId: uuidv7(),
        name: "app_launch",
        occurredAt: api.clock.now().toISOString(),
        props: { hasInvitation: false },
      },
    ],
  };
}
beforeAll(async () => {
  api = await testApi.start();
  api.clock.set(new Date("2026-10-08T04:00:00Z"));
  await seedUserAgreements(testApi, api);
  await runSeed({
    tx: api.runtime.tx,
    clock: api.clock,
    modules: SEED_MODULES.filter((seed) => ["config", "notify"].includes(seed.module)),
  });
  owner = await signInAsMerchant(api);
}, 120_000);
describe("四接口真实middleware/pipeline", () => {
  it("匿名/无效session信封原文202、未配只受理；后台登录页optional保持CSRF", async () => {
    for (const headers of [
      contentType,
      { ...contentType, Authorization: "Bearer invalid-session", "x-client-version": "0.0.0" },
    ]) {
      const response = await api.request("/api/v1/m/client-errors", {
        method: "POST",
        body: envelope("Example 13800000000 Bearer fixture"),
        headers,
      });
      expect(response.status).toBe(202);
      expect((await jsonBody(response)).data).toBeNull();
    }
    const response = await api.request("/api/v1/admin/client-errors", {
      method: "POST",
      body: envelope(),
      headers: { ...contentType, Origin: "http://localhost", "X-LYX-Admin": "1" },
    });
    expect(response.status).toBe(202);
    expect((await jsonBody(response)).data).toBeNull();
    expect(
      (
        await api.request("/api/v1/admin/client-errors", {
          method: "POST",
          body: envelope(),
          headers: contentType,
        })
      ).status,
    ).toBe(403);
    expect(JSON.stringify(api.logs)).not.toContain("13800000000");
    expect(api.runtime.clientErrors.snapshot().forwarded).toBe(0);
  });
  it("信封不JSON重编码；坏JSON/contentType/格式返回正式400", async () => {
    for (const [body, headers] of [
      [JSON.stringify(envelope()), contentType],
      ["broken envelope", contentType],
      [envelope(), { "content-type": "application/json" }],
    ] as const) {
      const response = await api.request("/api/v1/m/client-errors", {
        method: "POST",
        body,
        headers,
      });
      expect(response.status).toBe(400);
      expect((await jsonBody(response)).error).toBe("VALIDATION_FAILED");
    }
  });
  it("埋点逐条结果/并发去重与匿名引导真实空；低版本不误拦", async () => {
    const input = batch();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.request("/api/v1/m/analytics-events", {
          method: "POST",
          json: input,
          headers: { "x-client-version": "0.0.0" },
        }),
      ),
    );
    expect(results.every((response) => response.status === 200)).toBe(true);
    const outcomes = await Promise.all(
      results.map(async (response) => (await jsonBody<AnalyticsIngestResult>(response)).data),
    );
    expect(outcomes.reduce((n, row) => n + row.accepted, 0)).toBe(1);
    expect(outcomes.reduce((n, row) => n + row.duplicated, 0)).toBe(3);
    const partial = batch();
    partial.events.push({
      ...partial.events[0]!,
      eventId: uuidv7(),
      props: { hasInvitation: false, phone: "13800000000" },
    } as (typeof partial.events)[number]);
    const partialInput = {
      ...partial,
      events: [
        ...partial.events,
        { ...partial.events[0], eventId: uuidv7(), name: "order_submit" },
        { eventId: uuidv7(), name: "app_launch", occurredAt: api.clock.now().toISOString() },
      ],
    };
    const response = await api.request("/api/v1/m/analytics-events", {
      method: "POST",
      json: partialInput,
    });
    expect((await jsonBody(response)).data).toEqual({
      accepted: 1,
      duplicated: 0,
      rejected: 3,
      dropped: 0,
    });
    const bootstrap = await api.request("/api/v1/m/bootstrap");
    expect(bootstrap.status).toBe(200);
    expect((await jsonBody<Bootstrap>(bootstrap)).data.subscribePlan).toBeNull();
  });
  it("订阅required准确键、真实session绑定与重放；客户端身份不能注入", async () => {
    const input = {
      reportId: uuidv7(),
      point: "profile_submit",
      results: [{ tmplId: "unknown-template", result: "accept" }],
    };
    const path = "/api/v1/m/subscribe-results";
    expect((await api.request(path, { method: "POST", json: input })).status).toBe(401);
    const missing = await api.request(path, {
      method: "POST",
      json: input,
      headers: owner.headers,
    });
    expect(missing.status).toBe(400);
    const wrong = await api.request(path, {
      method: "POST",
      json: input,
      headers: { ...owner.headers, "Idempotency-Key": "subscribeReport:wrong" },
    });
    expect(wrong.status).toBe(400);
    const headers = { ...owner.headers, "Idempotency-Key": `subscribeReport:${input.reportId}` };
    for (let i = 0; i < 2; i++) {
      const response = await api.request(path, { method: "POST", json: input, headers });
      expect(response.status).toBe(200);
      expect((await jsonBody(response)).data).toEqual({ appliedCount: 0, ignoredCount: 1 });
    }
    const spoofed = await api.request(path, {
      method: "POST",
      json: { ...input, merchantUserId: uuidv7() },
      headers: { ...owner.headers, "Idempotency-Key": `subscribeReport:${uuidv7()}` },
    });
    expect(spoofed.status).toBe(400);
  });
  it("三入口真实byte超限413；在业务解析前短路并保留其它middleware", async () => {
    for (const [path, size, headers] of [
      ["/api/v1/m/analytics-events", 64 * 1024, { "content-type": "application/json" }],
      ["/api/v1/m/client-errors", 200 * 1024, contentType],
      [
        "/api/v1/admin/client-errors",
        200 * 1024,
        { ...contentType, Origin: "http://localhost", "X-LYX-Admin": "1" },
      ],
    ] as const) {
      const response = await api.request(path, {
        method: "POST",
        body: "x".repeat(size + 1),
        headers,
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("Payload Too Large");
    }
  });
  it("匿名telemetry原10/min限流保留429，无额外转发", async () => {
    const peer = "198.18.100.42";
    for (let i = 0; i < 10; i++)
      expect(
        (
          await api.request("/api/v1/m/client-errors", {
            method: "POST",
            body: envelope(),
            headers: contentType,
            peer,
          })
        ).status,
      ).toBe(202);
    const response = await api.request("/api/v1/m/client-errors", {
      method: "POST",
      body: envelope(),
      headers: contentType,
      peer,
    });
    expect(response.status).toBe(429);
    expect((await jsonBody(response)).error).toBe("RATE_LIMITED");
  });
});

// 设置真正的最低版本/待同意版本，验证豁免不是因为默认门槛0而偶然通过。
it("未同意且低版本仍能上报，原非豁免路由保持426/428", async () => {
  const staff = await signInAsStaff(await testApi.db.prisma(), {
    roleKey: "super_admin",
    now: api.clock.now(),
  });
  const versions = await api.request("/api/v1/admin/feature-flags", { headers: staff.headers });
  expect(versions.status).toBe(200);
  const min = (
    await jsonBody<{ items: { flagKey: string; lockVersion: number }[] }>(versions)
  ).data.items.find((item: { flagKey: string }) => item.flagKey === "client.min_version");
  if (!min) throw new Error("隔离种子缺client.min_version");
  const updated = await api.request("/api/v1/admin/feature-flags/client.min_version", {
    method: "PATCH",
    json: { lockVersion: min.lockVersion, defaultValue: "99.0.0" },
    headers: { ...staff.headers, "Idempotency-Key": uuidv7() },
  });
  expect(updated.status).toBe(200);
  const low = { ...owner.headers, "x-client-version": "0.0.0" };
  expect((await api.request("/api/v1/m/me", { headers: low })).status).toBe(426);
  for (const [path, body, headers] of [
    ["/api/v1/m/client-errors", envelope(), { ...low, ...contentType }],
    [
      "/api/v1/m/analytics-events",
      JSON.stringify(batch()),
      { ...low, "content-type": "application/json" },
    ],
  ] as const)
    expect(
      (await api.request(path, { method: "POST", body, headers, peer: "198.18.101.43" })).status,
    ).toBe(path.includes("client-errors") ? 202 : 200);
  const make = createFactories({ db: await testApi.db.prisma(), clock: api.clock });
  await make.agreementVersion({
    agreementKey: "privacy",
    status: "pending",
    effectiveAt: api.clock.now(),
    isReconsentRequired: true,
  });
  merchantServicesOf(api.runtime).identity.consentGate.invalidate();
  const reportId = uuidv7();
  expect(
    (
      await api.request("/api/v1/m/subscribe-results", {
        method: "POST",
        json: {
          reportId,
          point: "profile_submit",
          results: [{ tmplId: "unknown-template", result: "reject" }],
        },
        headers: {
          ...owner.headers,
          "x-client-version": "99.0.0",
          "Idempotency-Key": `subscribeReport:${reportId}`,
        },
      })
    ).status,
  ).toBe(428);
  expect(
    (
      await api.request("/api/v1/m/client-errors", {
        method: "POST",
        body: envelope(),
        headers: { ...low, ...contentType },
        peer: "198.18.101.44",
      })
    ).status,
  ).toBe(202);
  expect(
    (
      await api.request("/api/v1/m/analytics-events", {
        method: "POST",
        json: batch(),
        headers: low,
      })
    ).status,
  ).toBe(200);
});
