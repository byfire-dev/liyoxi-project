import { createHmac, timingSafeEqual } from "node:crypto";
import { hookRoute, z } from "@liyoxi/contract";
import { AppError, uuidv7 } from "@liyoxi/services";
import type { security } from "@liyoxi/services";
import { describe, expect, it } from "vitest";
import { receiveWebhook, webhookRateLimit } from "../src/http/webhook.js";
import { defineHandler } from "../src/routing/define.js";
import { useTestApi } from "../src/testing/index.js";

const api = useTestApi();
const key = Buffer.alloc(32, 0x39); // 本地协议替身，非真实平台密钥。
const signature = (body: string, at: string) =>
  createHmac("sha256", key).update(`${at}\n`).update(body).digest("hex");
const post = hookRoute({
  method: "post",
  path: "/hooks/wecom/lyxtest-events",
  operationId: "hooks.lyxtest.eventNotify.receive",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({ eventId: z.string(), eventType: z.string(), data: z.string() }),
        },
      },
    },
  },
  responses: { 200: { description: "协议成功" } },
});
const get = hookRoute({
  method: "get",
  path: "/hooks/wecom/lyxtest-events",
  operationId: "hooks.lyxtest.event.verify",
  responses: { 200: { description: "原文校验回显" } },
});
const handlers = [
  defineHandler(post, async (c) => {
    expect(c.get("idem")).toBeUndefined();
    expect(c.get("identity")).toBeUndefined();
    return receiveWebhook(c);
  }),
  defineHandler(get, async (c) => receiveWebhook(c)),
];
const fixture = (): security.WebhookSource => ({
  provider: "wecom",
  mode: "inbox",
  verify: async (input) => {
    const body = Buffer.from(input.rawBody).toString();
    const at = input.headers["x-fixture-at"] ?? "";
    const signedBody = input.method === "GET" ? (input.query?.["echostr"] ?? "") : body;
    const actual = Buffer.from(input.headers["x-fixture-signature"] ?? "", "hex");
    const expected = Buffer.from(signature(signedBody, at), "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected))
      return { kind: "error", error: "WEBHOOK_SIGNATURE_INVALID" };
    if (input.method === "GET")
      return {
        kind: "reply",
        status: 200,
        body: signedBody,
        timestamp: new Date(at),
        headers: { "cache-control": "public,max-age=3600" },
      };
    const data = JSON.parse(body) as { eventId: string; eventType: string; data: string };
    if (data.eventType === "fixture.unknown")
      return {
        kind: "skip",
        reason: "unregistered_event",
        reply: { kind: "reply", status: 200, body: "success" },
        timestamp: new Date(at),
      };
    return { kind: "event", event: { ...data, timestamp: new Date(at) } };
  },
  payload: (event) => ({ value: event.data }),
  restore: async (row) => row.payload?.["value"] ?? null,
  handle: async () => "processed",
  reply: (ok, error) => ({
    kind: "reply",
    status: ok ? 200 : 400,
    body: ok ? "success" : `failure:${error}`,
  }),
});
const body = (eventId = uuidv7()) =>
  JSON.stringify({ eventId, eventType: "fixture.received", data: "known" });
const signed = (value: string, at: Date) => ({
  "content-type": "application/json",
  "x-fixture-at": at.toISOString(),
  "x-fixture-signature": signature(value, at.toISOString()),
});

describe("hooks 真实装配：原文→一次IP限流→验签→协议应答", () => {
  it(
    "真实原文包括空白可验签，OpenAPI只在验签后解析；重复只落一条收件/出站",
    { timeout: 60_000 },
    async () => {
      const test = await api.start({ handlers, webhookSources: [fixture()] });
      const id = uuidv7();
      const value = ` \n${body(id)}\n `;
      const send = () =>
        test.request(post.path, {
          method: "POST",
          body: value,
          headers: signed(value, test.clock.now()),
        });
      expect(await (await send()).text()).toBe("success");
      expect(await (await send()).text()).toBe("success");
      const prisma = await api.db.prisma();
      expect(await prisma.webhookEvent.count({ where: { eventId: id } })).toBe(1);
      const row = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: id } });
      expect(
        await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
      ).toBe(1);
    },
  );

  it(
    "坏签名的坏JSON先按签名失败拒绝，篡改一字节/坏JSON均零写且日志不含原文",
    { timeout: 60_000 },
    async () => {
      const test = await api.start({ handlers, webhookSources: [fixture()] });
      const prisma = await api.db.prisma();
      const before = await prisma.webhookEvent.count();
      const secret = "untrusted-secret-payer-body";
      const bad = await test.request(post.path, {
        method: "POST",
        body: secret,
        headers: signed("other", test.clock.now()),
      });
      expect(bad.status).toBe(400);
      expect(await bad.text()).toBe("failure:WEBHOOK_SIGNATURE_INVALID");
      const invalid = await test.request(post.path, {
        method: "POST",
        body: secret,
        headers: signed(secret, test.clock.now()),
      });
      expect(await invalid.text()).toBe("failure:WEBHOOK_PAYLOAD_INVALID");
      const valid = body();
      expect(
        (
          await test.request(post.path, {
            method: "POST",
            body: `${valid} `,
            headers: signed(valid, test.clock.now()),
          })
        ).status,
      ).toBe(400);
      expect(await prisma.webhookEvent.count()).toBe(before);
      expect(JSON.stringify(test.logs)).not.toContain(secret);
    },
  );

  it("五分钟等号允许，超过一毫秒拒绝；未启用/未登记来源零写", { timeout: 60_000 }, async () => {
    const test = await api.start({ handlers, webhookSources: [fixture()] });
    const value = body();
    const boundary = new Date(test.clock.now().getTime() - 300_000);
    expect(
      (
        await test.request(post.path, {
          method: "POST",
          body: value,
          headers: signed(value, boundary),
        })
      ).status,
    ).toBe(200);
    const late = body();
    expect(
      await (
        await test.request(post.path, {
          method: "POST",
          body: late,
          headers: signed(late, new Date(boundary.getTime() - 1)),
        })
      ).text(),
    ).toBe("failure:WEBHOOK_TIMESTAMP_SKEWED");
    const disabled = await api.start({
      handlers,
      webhookSources: [{ ...fixture(), enabled: () => false }],
    });
    expect(
      await (
        await disabled.request(post.path, {
          method: "POST",
          body: value,
          headers: signed(value, disabled.clock.now()),
        })
      ).text(),
    ).toBe("failure:WEBHOOK_SOURCE_DISABLED");
    const missing = await api.start({ handlers });
    expect(
      (
        await missing.request(post.path, {
          method: "POST",
          body: value,
          headers: signed(value, missing.clock.now()),
        })
      ).status,
    ).toBe(404);
  });

  it("GET校验只回显原文，不入收件，签名/echostr查询日志遮盖", { timeout: 60_000 }, async () => {
    const test = await api.start({ handlers, webhookSources: [fixture()] });
    const prisma = await api.db.prisma();
    const before = await prisma.webhookEvent.count();
    const echo = "encrypted-fixture-nonce";
    const response = await test.request(`${get.path}?echostr=${echo}&msg_signature=masked`, {
      headers: signed(echo, test.clock.now()),
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).not.toBeNull();
    expect(await response.text()).toBe(echo);
    expect(await prisma.webhookEvent.count()).toBe(before);
    expect(JSON.stringify(test.logs)).not.toContain(echo);
  });

  it("按三组挂维护替身时hooks仍完整验签/收件，不进入维护拦截", { timeout: 60_000 }, async () => {
    let blocked = 0;
    const test = await api.start({
      handlers,
      webhookSources: [fixture()],
      middlewares: [
        {
          slot: "featureFlag",
          groups: ["m", "admin", "portal"],
          factory: () => async () => {
            blocked++;
            throw new AppError("MAINTENANCE");
          },
        },
      ],
    });
    const value = body();
    expect(
      await (
        await test.request(post.path, {
          method: "POST",
          body: value,
          headers: signed(value, test.clock.now()),
        })
      ).text(),
    ).toBe("success");
    expect(blocked).toBe(0);
  });

  it(
    "只有一次hooks.ip计数，坏签名也消耗额度；429保留协议失败与Retry-After",
    { timeout: 60_000 },
    async () => {
      const details: unknown[] = [];
      const test = await api.start({
        handlers,
        webhookSources: [
          {
            ...fixture(),
            reply: (ok, error, value) => {
              details.push(value);
              return fixture().reply(ok, error, value);
            },
          },
        ],
        middlewares: [
          {
            slot: "rateLimit",
            groups: ["hooks"],
            factory: webhookRateLimit({
              quotas: { "hooks.ip": [{ by: "ip", limit: 2, windowSec: 60 }] },
            }),
          },
        ],
      });
      const value = body();
      expect(
        (
          await test.request(post.path, {
            method: "POST",
            body: value,
            headers: signed("wrong", test.clock.now()),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await test.request(post.path, {
            method: "POST",
            body: value,
            headers: signed(value, test.clock.now()),
          })
        ).status,
      ).toBe(200);
      const limited = await test.request(post.path, {
        method: "POST",
        body: value,
        headers: signed(value, test.clock.now()),
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).not.toBeNull();
      expect(await limited.text()).toBe("failure:RATE_LIMITED");
      expect(details.at(-1)).toEqual({ retryAfterSec: Number(limited.headers.get("Retry-After")) });
    },
  );

  it(
    "POST直接回包不能绕过收件；显式未登记事件成功但零写；GET事件拒绝",
    { timeout: 60_000 },
    async () => {
      const prisma = await api.db.prisma();
      const before = await prisma.webhookEvent.count();
      for (const status of [200, 500]) {
        const test = await api.start({
          handlers,
          webhookSources: [
            { ...fixture(), verify: async () => ({ kind: "reply", status, body: "bypass" }) },
          ],
        });
        const response = await test.request(post.path, {
          method: "POST",
          body: body(),
          headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("failure:WEBHOOK_PAYLOAD_INVALID");
      }
      const test = await api.start({ handlers, webhookSources: [fixture()] });
      const value = JSON.stringify({
        eventId: uuidv7(),
        eventType: "fixture.unknown",
        data: "unknown",
      });
      expect(
        await (
          await test.request(post.path, {
            method: "POST",
            body: value,
            headers: signed(value, test.clock.now()),
          })
        ).text(),
      ).toBe("success");
      const eventGet = await api.start({
        handlers,
        webhookSources: [
          {
            ...fixture(),
            verify: async () => ({
              kind: "event",
              event: { eventId: uuidv7(), eventType: "fixture.received", data: null },
            }),
          },
        ],
      });
      expect((await eventGet.request(get.path)).status).toBe(400);
      const oldEcho = await test.request(`${get.path}?echostr=old`, {
        headers: signed("old", new Date(test.clock.now().getTime() - 300001)),
      });
      expect(await oldEcho.text()).toBe("failure:WEBHOOK_TIMESTAMP_SKEWED");
      expect(await prisma.webhookEvent.count()).toBe(before);
    },
  );

  it(
    "chunked超过1MB在verify前拒绝，不信Content-Length且零收件/事件",
    { timeout: 60_000 },
    async () => {
      let verified = 0;
      const input = fixture();
      const test = await api.start({
        handlers,
        webhookSources: [
          {
            ...input,
            verify: async (request) => {
              verified++;
              return input.verify(request);
            },
          },
        ],
      });
      const prisma = await api.db.prisma();
      const before = await prisma.webhookEvent.count();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(700_000));
          controller.enqueue(new Uint8Array(400_000));
          controller.close();
        },
      });
      const response = await test.api.app.request(post.path, {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(413);
      expect(verified).toBe(0);
      expect(await prisma.webhookEvent.count()).toBe(before);
    },
  );
});
