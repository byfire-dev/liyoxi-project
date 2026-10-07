import { describe, expect, it } from "vitest";
import { createClientReporting } from "./client-reporting";
import { createRequestLayer } from "./request";
import type { WireRequest } from "./platform";
import type { AnalyticsEventBatch } from "./track";
const id = "00000000-0000-4000-8000-000000000001";
const batch: AnalyticsEventBatch = {
  sentAt: "2026-10-08T00:00:00.000Z",
  anonymousId: id,
  sessionId: id,
  platform: "ios",
  clientVersion: "1.0.0",
  events: [
    {
      eventId: id,
      name: "app_launch",
      occurredAt: "2026-10-08T00:00:00.000Z",
      props: { hasInvitation: false },
    },
  ],
};
function setup(status = 200, mode: "ok" | "network" = "ok", baseUrl = "https://api.example.test") {
  const sent: WireRequest[] = [];
  const layer = createRequestLayer({
    baseUrl,
    send: async (request) => {
      sent.push(request);
      if (mode === "network") throw new Error("fake network");
      return {
        statusCode: status,
        header: {},
        data:
          status < 400
            ? { code: 0, message: "ok", data: null }
            : {
                error: `HTTP_${status}`,
                message: "fake",
                code: 1,
                requestId: id,
                retryable: status >= 500,
              },
      };
    },
    clock: { now: () => 0, sleep: async () => {} },
    uuid: () => id,
    client: () => ({ platform: "ios", version: "1.0.0", envVersion: "trial" }),
    getToken: () => "fake-session",
    getStoreId: () => null,
  });
  return { calls: createClientReporting(layer.request), sent };
}
describe("W218中央request真实接线", () => {
  it("信封原文字节、内容类型、会话头照传，202受理一次", async () => {
    const { calls, sent } = setup(202);
    const raw = '{"dsn":"https://public@example.test/1"}\n{"type":"event"}\n{"message":"中文"}';
    await calls.sendClientError(raw);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.example.test/api/v1/m/client-errors");
    expect(sent[0]?.data).toBe(raw);
    expect(sent[0]?.header["content-type"]).toBe("application/x-sentry-envelope");
    expect(sent[0]?.header.Authorization).toBe("Bearer fake-session");
    expect(sent[0]?.header["Idempotency-Key"]).toBeUndefined();
  });
  it("真实四种订阅结果与reportId/幂等键照传，不能变成统一accept", async () => {
    const { calls, sent } = setup();
    const body = {
      reportId: id,
      point: "profile_submit" as const,
      results: ["accept", "reject", "ban", "filter"].map((result, n) => ({
        tmplId: `realconfigured${n}`,
        result: result as "accept" | "reject" | "ban" | "filter",
      })),
    };
    await calls.reportSubscribeResult(body, `subscribeReport:${id}`);
    expect(sent[0]?.data).toEqual(body);
    expect(sent[0]?.header["Idempotency-Key"]).toBe(`subscribeReport:${id}`);
    expect(sent[0]?.header["content-type"]).toBe("application/json");
  });
  for (const status of [400, 401, 403, 413, 429])
    it(`${status}丢弃且不在adapter另重发`, async () => {
      const { calls, sent } = setup(status);
      expect(await calls.sendAnalytics(batch)).toBe("drop");
      expect(sent).toHaveLength(1);
    });
  for (const status of [500, 503])
    it(`${status}交还队列retry`, async () => {
      const { calls, sent } = setup(status);
      expect(await calls.sendAnalytics(batch)).toBe("retry");
      expect(sent).toHaveLength(1);
    });
  it("网络失败retry；未配基址不外呼并受控drop", async () => {
    const network = setup(200, "network");
    expect(await network.calls.sendAnalytics(batch)).toBe("retry");
    expect(network.sent).toHaveLength(1);
    const missing = setup(200, "ok", "");
    expect(await missing.calls.sendAnalytics(batch)).toBe("drop");
    expect(missing.sent).toEqual([]);
  });
});
