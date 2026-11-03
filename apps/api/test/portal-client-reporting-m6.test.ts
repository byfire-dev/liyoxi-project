import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClientErrorForwarder, createIdentityContext, uuidv7 } from "@liyoxi/services";
import { clientErrorFrames } from "@liyoxi/shared/telemetry";
import {
  createPortalTestSession,
  createPortalTestStack,
  snapshotTables,
} from "@liyoxi/services/testing";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi, TEST_WEAPP_APPID } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi(),
  origin = "https://portal.example.invalid";
const headers = {
  Origin: origin,
  "X-LYX-Portal": "1",
  "content-type": "application/x-sentry-envelope",
};
const tables = [
  "portal_session",
  "portal_ticket",
  "auth_event",
  "audit_log",
  "outbox_event",
  "status_transition",
];
let api: TestApi, cookie: string, expiresAt: string;
let peer = 0;
function envelope(text = "Portal example error", dsn = "https://publickey@example.invalid/7") {
  const eventId = uuidv7().replaceAll("-", "");
  return `${JSON.stringify({ dsn, event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, exception: { values: [{ type: "Error", value: text }] } })}`;
}
const send = (init: TestRequestInit = {}) =>
  api.request("/api/v1/portal/client-errors", {
    method: "POST",
    headers,
    body: envelope(),
    peer: `198.18.126.${++peer}`,
    ...init,
  });
beforeAll(async () => {
  api = await handle.start({ portalPublicOrigin: origin });
});
beforeAll(async () => {
  await seedUserAgreements(handle, api);
});
beforeAll(async () => {
  const signed = await signInAsMerchant(api),
    services = merchantServicesOf(api.runtime);
  const membership = await services.tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: signed.merchantUserId, client: "weapp" },
    }),
  );
  const checked = await services.identity.authenticate(signed.token, { ip: "198.18.126.250" });
  if (!checked.ok) throw new Error("portal reporting owner login failed");
  const stack = createPortalTestStack({
    tx: api.runtime.tx,
    clock: api.clock,
    appid: TEST_WEAPP_APPID,
    origin,
    ticketTtlSeconds: 120,
  });
  const world = await createPortalTestSession(
    stack,
    {
      principal: checked.principal,
      ctx: createIdentityContext({
        actor: { type: "merchant", id: signed.merchantUserId, client: "weapp", role: "owner" },
        ...membership,
      }),
    },
    {
      requestId: uuidv7(),
      ip: "198.18.126.250",
      userAgent: "Portal reporting HTTP test",
      clientVersion: "1.4.0",
    },
  );
  cookie = `__Host-lyx_portal=${world.token}`;
  expiresAt = world.session.expiresAt;
});

describe("portal.clientError.create 真实 HTTP", () => {
  it("portal编译帧经真实handler、清洗和队列精确转发，跨组件及源码上下文仍丢弃", async () => {
    const dsn = "https://fictionalportal@errors.example.invalid/42";
    const upstreamDsn = "https://fictionalupstream@relay.example.invalid/sentry/7";
    const asset = "assets/index-Ab12_cd3.js";
    const canonical = {
      filename: asset,
      abs_path: `app:///portal/${asset}`,
      lineno: 2,
      colno: 9,
      in_app: true,
    };
    const parsed = clientErrorFrames(
      `Error: fixture\n at fail (${origin}/${asset}:2:9)`,
      "portal",
      origin,
    );
    expect(parsed).toEqual([canonical]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const forwarder = createClientErrorForwarder({
      clock: api.clock,
      logger: api.runtime.logger,
      projects: [{ dsn, upstreamDsn }],
      fetch,
    });
    // 只替换本测试的虚构上游配置边界；handler委托真实factory的accept，清洗与队列均非替身。
    const accept = vi
      .spyOn(api.runtime.clientErrors, "accept")
      .mockImplementation(forwarder.accept);
    try {
      const prisma = await handle.db.prisma();
      const before = await snapshotTables(prisma, tables);
      for (const dist of ["portal", "admin", "weapp", "unknown", "api", "worker"]) {
        const eventId = uuidv7().replaceAll("-", "");
        const event = {
          event_id: eventId,
          release: "sha-0123456789ab",
          dist,
          debug_meta: { images: [{ debug_id: "private-debug" }] },
          exception: {
            values: [
              {
                type: "Error",
                value: "13800138000 Bearer portal-private-token",
                stacktrace: {
                  frames:
                    dist === "portal"
                      ? [
                          {
                            ...parsed[0],
                            function: "private function",
                            vars: { token: "portal-private-token" },
                            pre_context: ["private source"],
                            context_line: "private source",
                            post_context: ["private source"],
                          },
                          { ...canonical, abs_path: `app:///admin/${asset}` },
                          { ...canonical, abs_path: `app:///weapp/${asset}` },
                          { ...canonical, abs_path: `https://other.example.invalid/${asset}` },
                          { ...canonical, filename: `../${asset}` },
                          { ...canonical, lineno: 0 },
                          { ...canonical, colno: 2_147_483_648 },
                        ]
                      : [canonical],
                },
              },
            ],
          },
        };
        const body = `${JSON.stringify({ dsn, event_id: eventId })}\n{"type":"event"}\n${JSON.stringify(event)}`;
        const response = await send({ body });
        expect(response.status, await response.clone().text()).toBe(202);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ code: 0, message: "ok", data: null });
      }
      await forwarder.drain();
      expect(accept).toHaveBeenCalledTimes(6);
      expect(accept.mock.calls.every(([raw]) => raw instanceof Uint8Array)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(6);
      const events = fetch.mock.calls.map(([url, init]) => {
        expect(url).toBe("https://relay.example.invalid/sentry/api/7/envelope/");
        expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
        const body = String(init!.body);
        expect(body).not.toMatch(
          /13800138000|portal-private-token|private function|private source|private-debug/,
        );
        const [header, item, payload] = body.split("\n");
        expect(JSON.parse(header!).dsn).toBe(upstreamDsn);
        expect(JSON.parse(item!).length).toBe(Buffer.byteLength(payload!));
        return JSON.parse(payload!);
      });
      expect(events[0]).toMatchObject({ release: "sha-0123456789ab", dist: "portal" });
      expect(events[0].exception.values[0].stacktrace).toEqual({ frames: [canonical] });
      for (const event of events.slice(1))
        expect(event.exception.values[0].stacktrace).toBeUndefined();
      expect(forwarder.snapshot()).toMatchObject({ forwarded: 6, failed: 0, queued: 0, active: 0 });
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(JSON.stringify(api.logs)).not.toMatch(
        /13800138000|portal-private-token|private source/,
      );
    } finally {
      accept.mockRestore();
      await forwarder.close();
    }
  });

  it("匿名、有效、无效与实际过期会话均 optional 受理 202；不写业务、不转发未配置上游", async () => {
    expect(api.api.mountedOperations.filter((op) => op === "portal.clientError.create")).toEqual([
      "portal.clientError.create",
    ]);
    const prisma = await handle.db.prisma(),
      before = await snapshotTables(prisma, tables),
      now = api.clock.now();
    try {
      for (const current of [undefined, cookie, "__Host-lyx_portal=invalid"]) {
        const response = await send({
          headers: { ...headers, ...(current ? { Cookie: current } : {}) },
          body: envelope("Fictional 13800000000 Bearer test-token"),
        });
        expect(response.status, await response.clone().text()).toBe(202);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ code: 0, message: "ok", data: null });
      }
      api.clock.set(new Date(expiresAt));
      const expired = await send({ headers: { ...headers, Cookie: cookie } });
      expect(expired.status).toBe(202);
      expect(expired.headers.get("Cache-Control")).toBe("no-store");
      expect(
        (await api.request("/api/v1/portal/sessions/current", { headers: { Cookie: cookie } }))
          .status,
      ).toBe(401);
      expect(await snapshotTables(prisma, tables)).toEqual(before);
      expect(api.runtime.clientErrors.snapshot()).toMatchObject({
        forwarded: 0,
        queued: 0,
        active: 0,
      });
      expect(JSON.stringify(api.logs)).not.toContain("13800000000");
      expect(JSON.stringify(api.logs)).not.toContain("test-token");
    } finally {
      api.clock.set(now);
    }
  });

  it("匿名也保留同源 Origin 与 X-LYX-Portal，缺失或伪造均 403", async () => {
    const deniedHeaders: Record<string, string>[] = [
      { "content-type": headers["content-type"] },
      { ...headers, Origin: "https://other.example.invalid" },
      { ...headers, "X-LYX-Portal": "0" },
      { Origin: origin, "content-type": headers["content-type"] },
    ];
    for (const denied of deniedHeaders) {
      const response = await send({ headers: denied });
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("只收原始信封；坏格式、错误 MIME 与非法 DSN 返回正式 400", async () => {
    for (const [body, contentType] of [
      [JSON.stringify(envelope()), headers["content-type"]],
      ["broken envelope", headers["content-type"]],
      [envelope(), "application/json"],
      [envelope("test", "http://publickey@example.invalid/7"), headers["content-type"]],
      [envelope("test", "https://publickey:password@example.invalid/7"), headers["content-type"]],
    ] as const) {
      const response = await send({ body, headers: { ...headers, "content-type": contentType! } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "VALIDATION_FAILED" });
    }
    expect(api.runtime.clientErrors.snapshot().forwarded).toBe(0);
  });

  it("原 200 KiB 真实字节上限仍先于解析，伪造 Content-Length 不放行", async () => {
    const body = "中".repeat(Math.ceil((200 * 1024) / 3));
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(200 * 1024);
    const variants: Record<string, string>[] = [headers, { ...headers, "content-length": "1" }];
    for (const requestHeaders of variants) {
      const response = await send({ body, headers: requestHeaders });
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("Payload Too Large");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("原 telemetry 每分钟 10 次限制保留，前十次 202、下一次 429", async () => {
    const fixedPeer = "198.18.126.249";
    for (let index = 0; index < 10; index++)
      expect((await send({ peer: fixedPeer })).status).toBe(202);
    const response = await send({ peer: fixedPeer });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect(api.runtime.clientErrors.snapshot().forwarded).toBe(0);
  });
});
