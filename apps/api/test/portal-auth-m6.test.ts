import {
  PortalSessionListSchema,
  PortalTicketCreatedSchema,
  PortalTicketPreviewSchema,
  PortalTicketStatusViewSchema,
  PortalSessionViewSchema,
  PortalTicketExchangeResultSchema,
  portalRoute,
  okResponse,
  NoDataSchema,
} from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories, snapshotTables, assertSnapshotsEqual } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../src/context.js";
import { merchantServicesOf } from "../src/merchant/services.js";
import { portalAuth, portalCapability, portalOperationAllowed } from "../src/http/portal-auth.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { prepareMixedPortalReads } from "./e2e/mixed-portal-reader.js";
import { readMixedGets } from "./e2e/mixed-openapi-reader.js";
import type { M1RequestInit } from "./e2e/in-process.js";

const testApi = useTestApi();
const origin = "https://portal.example.invalid";
const portalHeaders = { Origin: origin, "X-LYX-Portal": "1" };
let api: TestApi;
let owner: SignedInMerchant;
let clerk: SignedInMerchant;
let storeId: string;
let entityId: string;
let peer = 10;
beforeAll(async () => {
  api = await testApi.start({ portalPublicOrigin: origin });
  await seedUserAgreements(testApi, api);
  owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  storeId = created.storeId;
  entityId = created.entityId;
  const make = createFactories({ db: await testApi.db.prisma(), clock: api.clock });
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: member.id, storeId, addedByMemberId: created.memberId });
}, 180_000);
async function call(path: string, init: TestRequestInit = {}) {
  const response = await api.request(`/api/v1${path}`, {
    peer: `198.18.10.${(peer++ % 240) + 1}`,
    ...init,
  });
  const text = await response.text();
  const body = JSON.parse(text) as { data?: unknown; error?: string; details?: unknown };
  return { response, body, text };
}
async function create() {
  const result = await call("/portal/portal-tickets", {
    method: "POST",
    headers: portalHeaders,
    json: {},
  });
  expect(result.response.status, result.text).toBe(200);
  return PortalTicketCreatedSchema.parse(result.body.data);
}
async function approve(ticket: Awaited<ReturnType<typeof create>>, key = uuidv7()) {
  return call(`/m/portal-tickets/${ticket.portalTicketId}/approve`, {
    method: "POST",
    headers: { ...owner.withStore(storeId), "Idempotency-Key": key },
    json: { pairDigits: ticket.pairDigits },
  });
}
async function login() {
  const ticket = await create();
  const approval = await approve(ticket);
  expect(approval.response.status, approval.text).toBe(200);
  const result = await call(`/portal/portal-tickets/${ticket.portalTicketId}/exchange`, {
    method: "POST",
    headers: portalHeaders,
    json: { pollSecret: ticket.pollSecret },
  });
  expect(result.response.status, result.text).toBe(200);
  const data = PortalTicketExchangeResultSchema.parse(result.body.data);
  expect(data.status).toBe("consumed");
  const setCookie = result.response.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  return { ticket, result, data, cookie, setCookie };
}
const dbTables = [
  "portal_ticket",
  "portal_session",
  "auth_event",
  "audit_log",
  "outbox_event",
  "status_transition",
  "idempotency_record",
];

describe("W6-05生产HTTP鉴权链：10API", () => {
  it("create → lookup → approve同键重放 → poll → exchange → current → list → revoke", async () => {
    expect(api.api.mountedOperations).toEqual(
      expect.arrayContaining([
        "m.portalTicket.lookup",
        "m.portalTicket.approve",
        "m.portalTicket.reject",
        "m.portalSession.list",
        "m.portalSession.revoke",
        "portal.portalTicket.create",
        "portal.portalTicket.get",
        "portal.portalTicket.exchange",
        "portal.session.current.get",
        "portal.session.current.delete",
      ]),
    );
    const ticket = await create();
    expect(ticket.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket.qrUrl).toMatch(/^https:\/\/portal.example.invalid\/a\?t=[A-Za-z0-9_-]{22}$/);
    const lookup = await call(`/m/portal-tickets/lookup?code=${ticket.shortCode}`, {
      headers: owner.withStore(storeId),
    });
    expect(lookup.response.status, lookup.text).toBe(200);
    const preview = PortalTicketPreviewSchema.parse(lookup.body.data);
    expect(preview.pairChoices).toContain(ticket.pairDigits);
    expect(lookup.text).not.toContain(ticket.pollSecret);
    const key = uuidv7();
    const first = await approve(ticket, key);
    expect(first.response.status, first.text).toBe(200);
    expect((await approve(ticket, key)).body).toEqual(first.body);
    expect((await approve(ticket)).response.status).toBe(410);
    const poll = await call(`/portal/portal-tickets/${ticket.portalTicketId}`, {
      headers: { "X-Poll-Secret": ticket.pollSecret },
    });
    expect(PortalTicketStatusViewSchema.parse(poll.body.data).status).toBe("approved");
    expect(poll.response.headers.get("cache-control")).toBe("no-store");
    const exchange = await call(`/portal/portal-tickets/${ticket.portalTicketId}/exchange`, {
      method: "POST",
      headers: portalHeaders,
      json: { pollSecret: ticket.pollSecret },
    });
    expect(exchange.response.status, exchange.text).toBe(200);
    const cookie = exchange.response.headers.get("set-cookie")!.split(";")[0]!;
    const current = await call("/portal/sessions/current", { headers: { Cookie: cookie } });
    const session = PortalSessionViewSchema.parse(current.body.data);
    expect(session).toMatchObject({ storeId, entityId, grantScope: "store" });
    const list = await call("/m/portal-sessions", { headers: owner.withStore(storeId) });
    expect(
      PortalSessionListSchema.parse(list.body.data).items.map((item) => item.portalSessionId),
    ).toContain(session.portalSessionId);
    const revoke = await call(`/m/portal-sessions/${session.portalSessionId}/revoke`, {
      method: "POST",
      headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
    });
    expect(revoke.response.status, revoke.text).toBe(200);
    const denied = await call("/portal/sessions/current", { headers: { Cookie: cookie } });
    expect(denied.response.status).toBe(401);
    expect(denied.body).toMatchObject({
      error: "PORTAL_SESSION_INVALID",
      details: { reason: "revoked", revokeReason: "owner_revoked" },
    });
  });
  it("Cookie精确属性、token不进JSON/日志/幂等结果；重放不生成第二会话；delete清Cookie", async () => {
    const world = await login();
    expect(world.setCookie).toMatch(
      /^__Host-lyx_portal=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=7200$/,
    );
    const token = world.cookie.split("=")[1]!;
    expect(world.result.text).not.toContain(token);
    const replay = await call(`/portal/portal-tickets/${world.ticket.portalTicketId}/exchange`, {
      method: "POST",
      headers: portalHeaders,
      json: { pollSecret: world.ticket.pollSecret },
    });
    expect(replay.response.status).toBe(410);
    expect(replay.response.headers.get("set-cookie")).toBeNull();
    const prisma = await testApi.db.prisma();
    expect(
      await prisma.portalSession.count({ where: { portalTicketId: world.ticket.portalTicketId } }),
    ).toBe(1);
    const before = await snapshotTables(prisma, dbTables);
    const current = await call("/portal/sessions/current", { headers: { Cookie: world.cookie } });
    expect(current.response.status).toBe(200);
    assertSnapshotsEqual(before, await snapshotTables(prisma, dbTables));
    const logout = await call("/portal/sessions/current", {
      method: "DELETE",
      headers: { ...portalHeaders, Cookie: world.cookie },
    });
    expect(logout.response.status, logout.text).toBe(200);
    expect(logout.body.data).toBeNull();
    expect(logout.response.headers.get("set-cookie")).toBe(
      "__Host-lyx_portal=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    );
    expect(
      (
        await call("/portal/sessions/current", {
          method: "DELETE",
          headers: { ...portalHeaders, Cookie: world.cookie },
        })
      ).response.status,
    ).toBe(401);
    const evidence = JSON.stringify(
      {
        logs: api.logs,
        idem: await prisma.idempotencyRecord.findMany(),
        auth: await prisma.authEvent.findMany(),
        audit: await prisma.auditLog.findMany(),
      },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(evidence).not.toContain(token);
    expect(evidence).not.toContain(world.ticket.pollSecret);
  });
  it("无Cookie、无效/重复Cookie均拒绝；公开写也必须Origin+自定义头，不开CORS", async () => {
    expect((await call("/portal/sessions/current")).body.error).toBe("AUTH_REQUIRED");
    for (const cookie of ["__Host-lyx_portal=bad", "__Host-lyx_portal=a; __Host-lyx_portal=b"]) {
      const result = await call("/portal/sessions/current", { headers: { Cookie: cookie } });
      expect(result.response.status).toBe(401);
      expect(result.body).toMatchObject({
        error: "PORTAL_SESSION_INVALID",
        details: { reason: "not_found" },
      });
    }
    const rejectedHeaders: Record<string, string>[] = [
      {},
      { Origin: origin },
      { "X-LYX-Portal": "1" },
      { ...portalHeaders, Origin: "https://evil.example.invalid" },
      { ...portalHeaders, Origin: origin + "/" },
    ];
    for (const headers of rejectedHeaders) {
      const result = await call("/portal/portal-tickets", { method: "POST", headers, json: {} });
      expect(result.response.status, result.text).toBe(403);
      expect(result.body.error).toBe("ORIGIN_REJECTED");
    }
    const options = await api.request("/api/v1/portal/portal-tickets", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.invalid", "Access-Control-Request-Method": "POST" },
    });
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("poll头格式400，错密钥/不存在统一404；过期只读投影；配对拒绝与reject均200", async () => {
    const ticket = await create();
    const prisma = await testApi.db.prisma();
    const before = await snapshotTables(prisma, dbTables);
    const invalidPollHeaders: Record<string, string>[] = [{}, { "X-Poll-Secret": "short" }];
    for (const headers of invalidPollHeaders) {
      expect(
        (await call(`/portal/portal-tickets/${ticket.portalTicketId}`, { headers })).response
          .status,
      ).toBe(400);
    }
    const wrong = "A".repeat(43);
    const bad = await call(`/portal/portal-tickets/${ticket.portalTicketId}`, {
      headers: { "X-Poll-Secret": wrong },
    });
    const absent = await call(`/portal/portal-tickets/${uuidv7()}`, {
      headers: { "X-Poll-Secret": wrong },
    });
    expect([bad.response.status, absent.response.status]).toEqual([404, 404]);
    expect(bad.body.error).toBe(absent.body.error);
    api.clock.advance(120_000);
    const expired = await call(`/portal/portal-tickets/${ticket.portalTicketId}`, {
      headers: { "X-Poll-Secret": ticket.pollSecret },
    });
    expect(PortalTicketStatusViewSchema.parse(expired.body.data).status).toBe("expired");
    assertSnapshotsEqual(before, await snapshotTables(prisma, dbTables));
    const reject = await create();
    const rejected = await call(`/m/portal-tickets/${reject.portalTicketId}/reject`, {
      method: "POST",
      headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
    });
    expect(rejected.response.status, rejected.text).toBe(200);
    expect(rejected.body.data).toMatchObject({ status: "rejected", rejectReason: "by_owner" });
    const mismatch = await create();
    const mismatchResult = await call(`/m/portal-tickets/${mismatch.portalTicketId}/approve`, {
      method: "POST",
      headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
      json: { pairDigits: mismatch.pairDigits === "00" ? "01" : "00" },
    });
    expect(mismatchResult.response.status, mismatchResult.text).toBe(200);
    expect(mismatchResult.body.data).toMatchObject({
      status: "rejected",
      rejectReason: "pair_mismatch",
    });
  });
  it("店员能力拒绝、跨店上下文拒绝、门户token不能走商家写接口；只读白名单不开放Q9", async () => {
    const ticket = await create();
    expect(
      (
        await call(`/m/portal-tickets/lookup?code=${ticket.shortCode}`, {
          headers: clerk.withStore(storeId),
        })
      ).response.status,
    ).toBe(403);
    expect(
      (
        await call(`/m/portal-tickets/lookup?code=${ticket.shortCode}`, {
          headers: owner.withStore(uuidv7()),
        })
      ).response.status,
    ).not.toBe(200);
    const world = await login();
    expect(
      (
        await call("/m/portal-sessions", {
          headers: { Authorization: `Bearer ${world.cookie.split("=")[1]}`, "X-Store-Id": storeId },
        })
      ).response.status,
    ).toBe(401);
    for (const operation of [
      "portal.file.create",
      "portal.orderItem.sample.get",
      "portal.sample.playbackUrls",
      "portal.ad.confirm",
      "portal.order.create",
    ]) {
      expect(portalOperationAllowed(operation, "sample.view", false)).toBe(false);
    }
    expect(
      portalOperationAllowed("portal.orderItem.downloadUrls", "delivery.download", false),
    ).toBe(true);
    expect(portalOperationAllowed("portal.ad.playbackUrls", "ad.view", false)).toBe(true);
  });
  it("原create IP10/min和poll每票据60/min限额真实生效", async () => {
    api.clock.advance(60_000);
    const limitedPeer = "198.18.250.9";
    for (let n = 0; n < 10; n++) {
      const result = await call("/portal/portal-tickets", {
        method: "POST",
        headers: portalHeaders,
        json: {},
        peer: limitedPeer,
      });
      expect(result.response.status, result.text).toBe(200);
    }
    const blocked = await call("/portal/portal-tickets", {
      method: "POST",
      headers: portalHeaders,
      json: {},
      peer: limitedPeer,
    });
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get("retry-after")).not.toBeNull();
    const ticket = await create();
    for (let n = 0; n < 60; n++) {
      const result = await call(`/portal/portal-tickets/${ticket.portalTicketId}`, {
        headers: { "X-Poll-Secret": ticket.pollSecret },
      });
      expect(result.response.status, result.text).toBe(200);
    }
    expect(
      (
        await call(`/portal/portal-tickets/${ticket.portalTicketId}`, {
          headers: { "X-Poll-Secret": ticket.pollSecret },
        })
      ).response.status,
    ).toBe(429);
  }, 60_000);
  it("optional原语：无/失效Cookie匿名，有效Cookie注入身份，内部错误不冒充匿名成功", async () => {
    const world = await login();
    // Only exercise the shipped middleware. No clientError business handler is mounted.
    const route = portalRoute({
      method: "post",
      path: "/portal/client-errors",
      operationId: "portal.clientError.create",
      "x-auth": "optional",
      "x-idempotent": "none",
      "x-idempotent-reason": "埋点与错误上报不落库",
      responses: okResponse(NoDataSchema),
    });
    const app = new Hono<ApiEnv>();
    app.onError((_error, c) => c.json({ error: "INTERNAL" }, 500));
    app.use("*", async (c, next) => {
      c.set("requestId", uuidv7());
      c.set("clientIp", "198.18.20.1");
      await next();
    });
    app.post(
      "/fixture",
      portalAuth(route, api.runtime)!,
      portalCapability(route, api.runtime)!,
      (c) => c.json({ actor: c.get("identity")?.actor ?? null }),
    );
    for (const cookie of [undefined, "__Host-lyx_portal=invalid"]) {
      const result = await app.request("/fixture", {
        method: "POST",
        headers: cookie ? { Cookie: cookie } : {},
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ actor: null });
    }
    const valid = await app.request("/fixture", {
      method: "POST",
      headers: { Cookie: world.cookie },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      actor: { type: "merchant", client: "portal", id: owner.merchantUserId },
    });
    const check = vi
      .spyOn(merchantServicesOf(api.runtime).portalSessions, "authenticate")
      .mockRejectedValueOnce(new Error("injected database failure"));
    try {
      const failed = await app.request("/fixture", {
        method: "POST",
        headers: { Cookie: world.cookie },
      });
      expect(failed.status).toBe(500);
    } finally {
      check.mockRestore();
    }
  });
  it("mixed reader真实票据与会话分别读取，Cookie不借给商家；清理后原凭据均失效", async () => {
    const selected = [
      "m.portalTicket.lookup",
      "m.portalSession.list",
      "portal.session.current.get",
    ];
    const requests: { path: string; init: M1RequestInit }[] = [];
    const transport = {
      request: async (path: string, init: M1RequestInit = {}) => {
        requests.push({ path, init });
        return api.request(path, { peer: `198.18.10.${(peer++ % 240) + 1}`, ...init });
      },
    };
    const signal = new AbortController().signal;
    const merchantHeaders = owner.withStore(storeId);
    const prepared = await prepareMixedPortalReads(transport, {
      operationIds: selected,
      merchantHeaders,
      origin,
      signal,
    });
    const lookupPath = `/api/v1/m/portal-tickets/lookup?code=${prepared.lookupCode}`;
    try {
      const reads = await readMixedGets(
        transport,
        [
          { operationId: selected[0]!, path: lookupPath },
          { operationId: selected[1]!, path: "/api/v1/m/portal-sessions" },
          { operationId: selected[2]!, path: "/api/v1/portal/sessions/current" },
        ],
        {},
        merchantHeaders,
        signal,
        prepared.headers,
      );
      expect(reads).toEqual(selected.map((operationId) => ({ operationId, status: 200 })));
      expect(JSON.stringify(reads)).not.toContain(prepared.lookupCode);
      expect(JSON.stringify(reads)).not.toContain(prepared.headers.Cookie);
      for (const { path, init } of requests) {
        const headers = new Headers(init.headers);
        if (path.startsWith("/api/v1/portal/")) expect(headers.has("authorization")).toBe(false);
        else expect(headers.has("cookie")).toBe(false);
      }
      expect(requests.filter((row) => row.path === "/api/v1/portal/portal-tickets")).toHaveLength(
        2,
      );
    } finally {
      await prepared.close();
    }
    const count = requests.length;
    await prepared.close();
    expect(requests).toHaveLength(count);
    expect((await api.request(lookupPath, { headers: merchantHeaders })).status).toBe(410);
    expect(
      (await api.request("/api/v1/portal/sessions/current", { headers: prepared.headers })).status,
    ).toBe(401);
  });
  it("mixed reader准备失败不伪造会话，已经创建的两张pending票据都正式拒绝", async () => {
    const tickets: Awaited<ReturnType<typeof create>>[] = [];
    const transport = {
      request: async (path: string, init: M1RequestInit = {}) => {
        if (path.endsWith("/approve")) return new Response(null, { status: 502 });
        const response = await api.request(path, {
          peer: `198.18.10.${(peer++ % 240) + 1}`,
          ...init,
        });
        if (path === "/api/v1/portal/portal-tickets") {
          const body = (await response.clone().json()) as { data: unknown };
          tickets.push(PortalTicketCreatedSchema.parse(body.data));
        }
        return response;
      },
    };
    await expect(
      prepareMixedPortalReads(transport, {
        operationIds: ["m.portalTicket.lookup", "portal.session.current.get"],
        merchantHeaders: owner.withStore(storeId),
        origin,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "read_failed" });
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      const poll = await call(`/portal/portal-tickets/${ticket.portalTicketId}`, {
        headers: { "X-Poll-Secret": ticket.pollSecret },
      });
      expect(poll.response.status).toBe(200);
      expect(PortalTicketStatusViewSchema.parse(poll.body.data).status).toBe("rejected");
    }
  });
  it("mixed reader一项清理失败仍退出真实会话，并保留cleanup_failed", async () => {
    let failedReject: string | undefined;
    const transport = {
      request: async (path: string, init: M1RequestInit = {}) => {
        if (path.endsWith("/reject")) {
          failedReject = path;
          return new Response(null, { status: 502 });
        }
        return api.request(path, { peer: `198.18.10.${(peer++ % 240) + 1}`, ...init });
      },
    };
    const prepared = await prepareMixedPortalReads(transport, {
      operationIds: ["m.portalTicket.lookup", "portal.session.current.get"],
      merchantHeaders: owner.withStore(storeId),
      origin,
      signal: new AbortController().signal,
    });
    try {
      await expect(prepared.close()).rejects.toMatchObject({ code: "cleanup_failed" });
      expect(failedReject).toBeDefined();
      expect(
        (await api.request("/api/v1/portal/sessions/current", { headers: prepared.headers }))
          .status,
      ).toBe(401);
    } finally {
      if (failedReject) {
        const rejected = await api.request(failedReject, {
          method: "POST",
          headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
        });
        expect(rejected.status).toBe(200);
      }
    }
  });
});
