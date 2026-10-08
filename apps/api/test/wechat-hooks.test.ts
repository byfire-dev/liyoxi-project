import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import {
  assembleServices,
  buildWorkerServices,
  createLogger,
  createRuntime,
  loadEnv,
} from "@liyoxi/services";
import {
  createClock,
  createProviderHarness,
  fakeKeyEnv,
  useTestDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { createApp } from "../src/app.js";
import { HANDLERS } from "../src/routes/index.js";
import { ROUTE_MIDDLEWARES } from "../src/routing/pipeline.js";
import { webhookRateLimit } from "../src/http/webhook.js";
import { provideMerchantDeps } from "../src/merchant/services.js";
import { TEST_API_KEYRING } from "../src/testing/index.js";
import { seedUserAgreements } from "../src/testing/merchant.js";

const db = useTestDatabase("api");
const redis = useTestRedis();
beforeAll(async () => {
  await db.url();
  await redis.client();
});
const key = Buffer.alloc(32, 0x49);
const config = {
  appid: "wx_fake_hooks_app",
  secret: "fake-hooks-secret",
  messageToken: "fake-hooks-token",
  messageEncodingAESKey: key.toString("base64").slice(0, -1),
};
const sha1 = (...parts: string[]) => createHash("sha1").update(parts.sort().join("")).digest("hex");
const path = "/api/v1/hooks/wechat/messages";
let fixtureSequence = 0;

// Native cipher builds independent wire bytes; the production crypto implementation is not a fixture.
function wire(message: Record<string, unknown>, now: Date, appid = config.appid) {
  const plain = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(plain.length);
  const raw = Buffer.concat([Buffer.alloc(16, 0x17), length, plain, Buffer.from(appid)]);
  const pad = 32 - (raw.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString("base64");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const nonce = "fake-hook-nonce";
  const query = new URLSearchParams({
    timestamp,
    nonce,
    encrypt_type: "aes",
    signature: sha1(config.messageToken, timestamp, nonce),
    msg_signature: sha1(config.messageToken, timestamp, nonce, encrypted),
  });
  return {
    url: `${path}?${query}`,
    body: ` \n${JSON.stringify({ ToUserName: "gh_fake_hook", Encrypt: encrypted })}\n `,
    headers: { "content-type": "application/json" },
    method: "POST",
  };
}
function decodeReply(encrypted: string) {
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
  return JSON.parse(raw.subarray(20, 20 + raw.readUInt32BE(16)).toString()) as Record<
    string,
    unknown
  >;
}
async function fixture(configured = true, limited = false) {
  const clock = createClock();
  const harness = createProviderHarness({ clock });
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    svc: "api",
    env: "test",
    level: "debug",
    version: "test",
    destination: {
      write(line) {
        logs.push(JSON.parse(String(line)) as Record<string, unknown>);
      },
    },
  });
  const runtime = createRuntime({
    entry: "api",
    version: "test",
    clock,
    providers: harness.providers,
    redisKeyPrefix: redis.prefix,
    logger,
    env: {
      ...loadEnv(),
      ...fakeKeyEnv(),
      DATABASE_URL: await db.url(),
      ...(configured ? { WECHAT: config } : {}),
    },
  });
  provideMerchantDeps(runtime, { keyring: TEST_API_KEYRING });
  const app = createApp({
    runtime,
    handlers: HANDLERS,
    ...(limited
      ? {
          pipeline: ROUTE_MIDDLEWARES.map((entry) =>
            entry.slot === "rateLimit" && entry.groups?.includes("hooks")
              ? {
                  ...entry,
                  factory: webhookRateLimit({
                    quotas: { "hooks.ip": [{ by: "ip", limit: 2, windowSec: 60 }] },
                  }),
                }
              : entry,
          ),
        }
      : {}),
  });
  const peer = `198.19.100.${++fixtureSequence}`;
  expect(app.mountedOperations).toEqual(
    expect.arrayContaining(["hooks.wechat.message.verify", "hooks.wechat.message.receive"]),
  );
  const request = (url: string, init?: RequestInit) =>
    app.app.request(url, init, { incoming: { socket: { remoteAddress: peer } } });
  return { clock, harness, runtime, request, logs };
}
const popup = (openid: string) => ({
  MsgType: "event",
  Event: "subscribe_msg_popup_event",
  FromUserName: openid,
  List: { TemplateId: "fake-template", SubscribeStatusString: "accept" },
});

it("hooks.wechat.message.verify: default configured runtime returns raw GET and rejects signature/skew without inbox", async () => {
  const f = await fixture();
  try {
    const prisma = await db.prisma();
    const before = await prisma.webhookEvent.count();
    const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
    const nonce = "fake-get-nonce";
    const q = new URLSearchParams({
      timestamp,
      nonce,
      echostr: "raw <echo>& value",
      signature: sha1(config.messageToken, timestamp, nonce),
    });
    const start = performance.now();
    const response = await f.request(`${path}?${q}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("raw <echo>& value");
    expect(performance.now() - start).toBeLessThan(5000);
    expect(response.headers.get("cache-control")).toBe("no-store");
    q.set("signature", "0".repeat(40));
    expect((await f.request(`${path}?${q}`)).status).toBe(401);
    q.set("timestamp", String(Number(timestamp) - 301));
    q.set("signature", sha1(config.messageToken, q.get("timestamp")!, nonce));
    expect((await f.request(`${path}?${q}`)).status).toBe(401);
    expect(await prisma.webhookEvent.count()).toBe(before);
    expect(f.harness.providers.wechat.calls).toHaveLength(0);
  } finally {
    await f.runtime.close();
  }
});

it("hooks.wechat.message.receive: concurrent raw encrypted requests project actual identity and worker processes receipt", async () => {
  const f = await fixture();
  try {
    const versions = await seedUserAgreements({ db }, { runtime: f.runtime, clock: f.clock });
    f.harness.providers.wechat.sessions.set("hook-login", { openid: "fictional-hook-openid" });
    f.harness.providers.wechat.phones.set("hook-phone", "13890001001");
    const login = await f.request("/api/v1/m/sessions/phone-login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-version": "1.4.0" },
      body: JSON.stringify({
        loginCode: "hook-login",
        phoneCode: "hook-phone",
        consents: [
          { agreementKey: "user", agreementVersionId: versions.user },
          { agreementKey: "privacy", agreementVersionId: versions.privacy },
        ],
      }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const prisma = await db.prisma();
    const identity = await prisma.wechatIdentity.findUniqueOrThrow({
      where: { appid_openid: { appid: config.appid, openid: "fictional-hook-openid" } },
    });
    const signed = wire(popup(identity.openid), f.clock.now());
    const start = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => f.request(signed.url, signed)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
    }
    expect(performance.now() - start).toBeLessThan(5000);
    const rows = await prisma.webhookEvent.findMany({
      where: { provider: "wechat", eventType: "subscribe_msg_popup_event" },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.payload).toEqual({
      event: "subscribe_msg_popup_event",
      wechatIdentityId: identity.id,
      items: [{ templateId: "fake-template", status: "accept" }],
    });
    expect(JSON.stringify(row.payload)).not.toContain(identity.openid);
    expect(
      await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
    ).toBe(1);
    await f.runtime.close();
    const worker = buildWorkerServices({
      appEnv: "test",
      prisma,
      clock: f.clock,
      assembly: assembleServices({ entry: "worker", appEnv: "test" }),
      providers: f.harness.providers,
      channel: { enqueue: async () => {}, downForMs: () => 0 },
      wechat: {
        config,
        transport: {
          redis: await redis.client(),
          prefix: redis.prefix,
          now: () => f.clock.now(),
          registerClose() {},
        },
      },
    });
    try {
      expect(await worker.reprocessWebhooks()).toBe(1);
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        processState: "processed",
      });
      expect(f.harness.providers.wechat.calls).toHaveLength(2);
    } finally {
      worker.closeWebhooks?.();
      worker.closeAnalytics?.();
      worker.closeOrder?.();
      worker.closeBillingTimers?.();
      worker.closePublish?.();
      worker.closeDelivery?.();
    }
  } finally {
    await f.runtime.close();
  }
}, 60000);

it("hooks.wechat.message.receive: customer reply decrypts as transfer, unknown returns success, both write nothing", async () => {
  const f = await fixture();
  try {
    const prisma = await db.prisma();
    const before = await prisma.webhookEvent.count();
    const customer = wire(
      {
        MsgType: "text",
        ToUserName: "gh_customer",
        FromUserName: "private-customer",
        CreateTime: 123,
        Content: "private-customer-content",
      },
      f.clock.now(),
    );
    const response = await f.request(customer.url, customer);
    expect(response.status).toBe(200);
    const reply = (await response.json()) as {
      Encrypt: string;
      MsgSignature: string;
      TimeStamp: number;
      Nonce: string;
    };
    expect(reply.MsgSignature).toBe(
      sha1(config.messageToken, String(reply.TimeStamp), reply.Nonce, reply.Encrypt),
    );
    expect(decodeReply(reply.Encrypt)).toMatchObject({
      ToUserName: "private-customer",
      FromUserName: "gh_customer",
      MsgType: "transfer_customer_service",
    });
    const unknown = wire(
      { MsgType: "event", Event: "unknown-fake", secret: "private-unknown" },
      f.clock.now(),
    );
    expect(await (await f.request(unknown.url, unknown)).text()).toBe("success");
    expect(await prisma.webhookEvent.count()).toBe(before);
    expect(JSON.stringify(f.logs)).not.toMatch(/private-customer|private-unknown/);
  } finally {
    await f.runtime.close();
  }
});

it("hooks.wechat.message.receive: wrong AppID, tampering and invalid image result reject with empty protocol bodies", async () => {
  const f = await fixture();
  try {
    const prisma = await db.prisma();
    const before = await prisma.webhookEvent.count();
    const wrong = wire(popup("private-wrong-app"), f.clock.now(), "wx_other_fake");
    const wrongResponse = await f.request(wrong.url, wrong);
    expect(wrongResponse.status).toBe(401);
    expect(await wrongResponse.text()).toBe("");
    const invalid = wire(
      {
        MsgType: "event",
        Event: "wxa_media_check",
        trace_id: "fake-download-error",
        errcode: -1008,
        result: { suggest: "pass", label: 100 },
      },
      f.clock.now(),
    );
    expect((await f.request(invalid.url, invalid)).status).toBe(400);
    const signed = wire(popup("private-tamper"), f.clock.now());
    const bad = new URL(signed.url, "http://localhost");
    bad.searchParams.set("msg_signature", "0".repeat(40));
    expect((await f.request(bad.pathname + bad.search, signed)).status).toBe(401);
    expect(await prisma.webhookEvent.count()).toBe(before);
  } finally {
    await f.runtime.close();
  }
});

it("hooks.wechat.message.receive: failed receiving transaction never ACKs or persists an event", async () => {
  const f = await fixture();
  try {
    const prisma = await db.prisma();
    const before = await prisma.webhookEvent.count();
    const failure = vi
      .spyOn(f.runtime.tx, "run")
      .mockRejectedValueOnce(new Error("fictional-database-failure"));
    const signed = wire(popup("unbound-fake"), f.clock.now());
    const response = await f.request(signed.url, signed);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    failure.mockRestore();
    expect(await prisma.webhookEvent.count()).toBe(before);
  } finally {
    await f.runtime.close();
  }
});

it("hooks.wechat.message.verify: absent trusted config leaves the source disabled without inbox", async () => {
  const f = await fixture(false);
  try {
    const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
    const nonce = "disabled-fake";
    const q = new URLSearchParams({
      timestamp,
      nonce,
      echostr: "fake",
      signature: sha1(config.messageToken, timestamp, nonce),
    });
    expect((await f.request(`${path}?${q}`)).status).toBe(404);
    expect(f.harness.providers.wechat.calls).toHaveLength(0);
  } finally {
    await f.runtime.close();
  }
});

it("hooks.wechat.message.receive: signed pipeline counts IP once and rate rejects before inbox", async () => {
  const f = await fixture(true, true);
  try {
    const prisma = await db.prisma();
    const before = await prisma.webhookEvent.count();
    const signed = wire({ MsgType: "event", Event: "unknown-rate-limit" }, f.clock.now());
    const invalid = new URL(signed.url, "http://localhost");
    invalid.searchParams.set("msg_signature", "0".repeat(40));
    expect((await f.request(invalid.pathname + invalid.search, signed)).status).toBe(401);
    expect((await f.request(signed.url, signed)).status).toBe(200);
    const limited = await f.request(signed.url, signed);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await prisma.webhookEvent.count()).toBe(before);
  } finally {
    await f.runtime.close();
  }
});
