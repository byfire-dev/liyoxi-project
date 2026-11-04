import { readFile, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { isErrorSymbol } from "@liyoxi/contract/errors";
import type { LiveReply, LiveSessionState } from "./browser-session";
import {
  CaseClosed,
  CaseReady,
  Cases,
  Facts,
  HttpResult,
  ReadResult,
  ReadWindow,
  control,
  liveContext,
  type CaseId,
} from "./control-client";

function data<T>(reply: LiveReply<T>): T {
  if (!reply.ok) throw new Error(`BROWSER_ACTION_FAILED_${reply.httpStatus}`);
  return reply.data;
}
function caseId(title: string): CaseId {
  if (!(Cases as readonly string[]).includes(title)) throw new Error("LIVE_CASE_INVALID");
  return title as CaseId;
}
async function shot(
  page: Page,
  name:
    | "session-ready"
    | "session-revoked"
    | "session-logout"
    | "ticket-rejected"
    | "login-pending"
    | "login-authorized"
    | "login-revoked"
    | "login-logout"
    | "login-rejected"
    | "login-refreshed"
    | "login-landing",
) {
  const privacy = await page.evaluate(() => window.__LYX_PORTAL_LIVE__.privacy());
  expect(Object.values(privacy).every((value) => value === true)).toBe(true);
  const { stageDirectory } = liveContext();
  await page.screenshot({ path: join(stageDirectory, `${name}.png`), animations: "disabled" });
  await writeFile(
    join(stageDirectory, `${name}.privacy.json`),
    `${JSON.stringify({ safe: true })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
async function ticket(page: Page) {
  return data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.beginTicket()));
}
async function approve(page: Page, id: CaseId, created: Awaited<ReturnType<typeof ticket>>) {
  const lookup = await control(
    id,
    { op: "ticket.lookup", input: { actor: "owner", code: created.shortCode } },
    HttpResult,
  );
  expect(lookup.httpStatus).toBe(200);
  expect(lookup.error).toBeNull();
  expect(lookup.data).toMatchObject({
    portalTicketId: created.portalTicketId,
    storeId: liveContext().actors.owner.storeId,
  });
  const decision = await control(
    id,
    {
      op: "ticket.decide",
      input: {
        actor: "owner",
        portalTicketId: created.portalTicketId,
        decision: "approve",
        pairDigits: created.pairDigits,
      },
    },
    HttpResult,
  );
  expect(decision).toMatchObject({
    httpStatus: 200,
    error: null,
    data: { status: "approved", rejectReason: null },
  });
  await expect
    .poll(
      async () => data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.pollTicket())).status,
      { timeout: 10_000, intervals: [2000] },
    )
    .toBe("approved");
  const result = data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.finishExchange()));
  expect(result.outcome).toBe("consumed");
  await expect(page.getByTestId("portal-live-private")).toBeVisible();
  await expect(page.getByTestId("portal-live-state")).toHaveAttribute(
    "data-status",
    "authenticated",
  );
  const state = await page.evaluate(() => window.__LYX_PORTAL_LIVE__.snapshot());
  expect(state).toMatchObject({
    authenticated: true,
    entityId: liveContext().actors.owner.entityId,
    storeId: liveContext().actors.owner.storeId,
  });
  expect(state.portalSessionId).not.toBeNull();
  return state;
}
async function assertCookie(page: Page) {
  // Project immediately; Cookie values never enter assertions, messages, files or attachments.
  const attributes = (await page.context().cookies()).map(
    ({ name, domain, path, httpOnly, secure, sameSite, expires }) => ({
      name,
      domain,
      path,
      httpOnly,
      secure,
      sameSite,
      remaining: expires - Date.now() / 1000,
    }),
  );
  expect(attributes).toHaveLength(1);
  expect(attributes[0]).toMatchObject({
    name: "__Host-lyx_portal",
    domain: "portal.localhost",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });
  expect(attributes[0]!.remaining).toBeGreaterThan(7100);
  expect(attributes[0]!.remaining).toBeLessThanOrEqual(7201);
  expect(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.privacy().documentCookieHidden)).toBe(
    true,
  );
}
async function stableRead(page: Page, id: CaseId) {
  const readWindow = await control(id, { op: "facts.beginRead", input: {} }, ReadWindow);
  const state = data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.loadSession()));
  const result = await control(
    id,
    { op: "facts.endRead", input: { windowId: readWindow.windowId } },
    ReadResult,
  );
  expect(result).toEqual({ unchanged: true, changedTables: [] });
  return state;
}

test.beforeEach(async ({ page }, info) => {
  await control(caseId(info.title), { op: "case.begin", input: {} }, CaseReady);
  if (info.title.startsWith("portal-login-page-")) {
    await page.goto("/");
    await expect(page.getByText(/^8 位登录码：/)).toBeVisible();
  } else {
    await page.goto("/__portal-live/session");
    await expect(page.getByTestId("portal-live-ready")).toBeVisible();
  }
  expect(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.version)).toBe(1);
  expect((await page.context().cookies()).length).toBe(0);
});
test.afterEach(async ({ page }, info) => {
  let disposalFailed = false;
  try {
    await page.evaluate(() => window.__LYX_PORTAL_LIVE__.dispose());
  } catch {
    disposalFailed = true;
  }
  const closed = await control(caseId(info.title), { op: "case.end", input: {} }, CaseClosed);
  if (info.status === "passed") {
    expect(disposalFailed).toBe(false);
    expect(closed.abandonedReadWindow).toBe(false);
  }
});

test("portal-authorize-revoke", async ({ page }) => {
  const id = "portal-authorize-revoke",
    created = await ticket(page);
  const clerk = await control(
    id,
    { op: "ticket.lookup", input: { actor: "clerk", code: created.shortCode } },
    HttpResult,
  );
  expect(clerk).toMatchObject({ httpStatus: 403, error: "ROLE_FORBIDDEN", data: null });
  const state = await approve(page, id, created);
  await assertCookie(page);
  const facts = await control(id, { op: "facts.tickets", input: {} }, Facts);
  expect(facts.items).toEqual([
    {
      portalTicketId: created.portalTicketId,
      storedStatus: "consumed",
      sessionIds: [state.portalSessionId],
      activeSessionCount: 1,
    },
  ]);
  expect((await stableRead(page, id)).authenticated).toBe(true);
  const other = await control(
    id,
    {
      op: "session.revoke",
      input: { actor: "otherOwner", portalSessionId: state.portalSessionId! },
    },
    HttpResult,
  );
  expect(other).toMatchObject({ httpStatus: 404, error: "NOT_FOUND", data: null });
  expect(
    data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.loadSession())).authenticated,
  ).toBe(true);
  const writeSurface = await page.evaluate(async () => {
    const response = await fetch("/api/v1/m/entities", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.status;
  });
  expect(writeSurface).toBe(404); // Real portal Host isolation; not a claim about merchant Bearer parsing.
  await shot(page, "session-ready");
  const revoked = await control(
    id,
    { op: "session.revoke", input: { actor: "owner", portalSessionId: state.portalSessionId! } },
    HttpResult,
  );
  expect(revoked).toMatchObject({
    httpStatus: 200,
    error: null,
    data: { portalSessionId: state.portalSessionId },
  });
  const invalid = data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.loadSession()));
  expect(invalid).toMatchObject({
    authenticated: false,
    status: "invalid",
    httpStatus: 401,
    error: "PORTAL_SESSION_INVALID",
    reason: "revoked",
    revokeReason: "owner_revoked",
  });
  await expect(page.getByTestId("portal-live-private")).toHaveCount(0);
  await shot(page, "session-revoked");
});

test("portal-logout", async ({ page }) => {
  const id = "portal-logout",
    created = await ticket(page);
  await approve(page, id, created);
  await assertCookie(page);
  const state = data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.logout()));
  expect(state.authenticated).toBe(false);
  expect((await page.context().cookies()).length).toBe(0);
  const current = await stableRead(page, id);
  expect(current).toMatchObject({
    status: "invalid",
    authenticated: false,
    httpStatus: 401,
    error: "AUTH_REQUIRED",
  });
  await expect(page.getByTestId("portal-live-private")).toHaveCount(0);
  const facts = await control(id, { op: "facts.tickets", input: {} }, Facts);
  expect(facts.items[0]).toMatchObject({
    portalTicketId: created.portalTicketId,
    activeSessionCount: 0,
  });
  await shot(page, "session-logout");
});

async function wrongOriginProbe() {
  const context = liveContext(),
    origin = new URL(context.origin);
  const cert = await readFile(join(dirname(context.controlSocketPath), "certificate.pem"));
  return new Promise<{ status: number; error: string | null }>((accept, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: Number(origin.port),
        servername: "portal.localhost",
        ca: cert,
        agent: false,
        path: "/api/v1/portal/portal-tickets",
        method: "POST",
        headers: {
          host: origin.host,
          origin: "https://wrong.example.invalid",
          "X-LYX-Portal": "1",
          "Content-Type": "application/json",
          "Content-Length": "2",
        },
      },
      (response) => {
        // An unexpected successful create body may contain a secret: discard it without parsing.
        if (response.statusCode !== 403) {
          response.resume();
          accept({ status: response.statusCode ?? 0, error: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) response.destroy();
          else chunks.push(chunk);
        });
        response.once("error", () => reject(new Error("CSRF_PROBE_FAILED")));
        response.once("end", () => {
          try {
            const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const error =
              typeof raw === "object" &&
              raw !== null &&
              "error" in raw &&
              typeof raw.error === "string" &&
              isErrorSymbol(raw.error)
                ? raw.error
                : null;
            accept({ status: 403, error });
          } catch {
            reject(new Error("CSRF_PROBE_FAILED"));
          }
        });
      },
    );
    request.setTimeout(10_000, () => request.destroy());
    request.once("error", () => reject(new Error("CSRF_PROBE_FAILED")));
    request.end("{}");
  });
}

test("portal-rejected-csrf", async ({ page }) => {
  const id = "portal-rejected-csrf",
    created = await ticket(page);
  const lookup = await control(
    id,
    { op: "ticket.lookup", input: { actor: "owner", code: created.shortCode } },
    HttpResult,
  );
  expect(lookup.httpStatus).toBe(200);
  const decision = await control(
    id,
    {
      op: "ticket.decide",
      input: {
        actor: "owner",
        portalTicketId: created.portalTicketId,
        decision: "approve",
        pairDigits: created.pairDigits === "00" ? "01" : "00",
      },
    },
    HttpResult,
  );
  expect(decision).toMatchObject({
    httpStatus: 200,
    error: null,
    data: { status: "rejected", rejectReason: "pair_mismatch" },
  });
  const readWindow = await control(id, { op: "facts.beginRead", input: {} }, ReadWindow);
  expect(data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.pollTicket())).status).toBe(
    "rejected",
  );
  const state: LiveSessionState = data(
    await page.evaluate(() => window.__LYX_PORTAL_LIVE__.loadSession()),
  );
  expect(state).toMatchObject({ authenticated: false, status: "invalid", httpStatus: 401 });
  expect(
    await control(
      id,
      { op: "facts.endRead", input: { windowId: readWindow.windowId } },
      ReadResult,
    ),
  ).toEqual({ unchanged: true, changedTables: [] });
  expect((await page.context().cookies()).length).toBe(0);
  const missingHeader = await page.evaluate(async () => {
    const response = await fetch("/api/v1/portal/portal-tickets", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status !== 403) return { status: response.status, error: null };
    const value: unknown = await response.json();
    return {
      status: response.status,
      error:
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        value.error === "ORIGIN_REJECTED"
          ? "ORIGIN_REJECTED"
          : null,
    };
  });
  expect(missingHeader).toEqual({ status: 403, error: "ORIGIN_REJECTED" });
  expect(await wrongOriginProbe()).toEqual({ status: 403, error: "ORIGIN_REJECTED" });
  expect((await control(id, { op: "facts.tickets", input: {} }, Facts)).items).toEqual([
    {
      portalTicketId: created.portalTicketId,
      storedStatus: "rejected",
      sessionIds: [],
      activeSessionCount: 0,
    },
  ]);
  await shot(page, "ticket-rejected");
});

/** Only displayed public codes enter the driver; no response bodies or poll secrets leave the browser. */
async function displayedTicket(page: Page, id: CaseId) {
  const codeText = await page.getByText(/^8 位登录码：/).innerText();
  const pairText = await page.getByText(/^确认数字：/).innerText();
  const code = /^8 位登录码：([0-9A-HJKMNP-TV-Z]{8})$/.exec(codeText)?.[1];
  const pairDigits = /^确认数字：(\d{2})$/.exec(pairText)?.[1];
  if (!code || !pairDigits) throw new Error("DISPLAYED_TICKET_INVALID");
  const lookup = await control(
    id,
    { op: "ticket.lookup", input: { actor: "owner", code } },
    HttpResult,
  );
  expect(lookup).toMatchObject({
    httpStatus: 200,
    error: null,
    data: { storeId: liveContext().actors.owner.storeId },
  });
  if (!lookup.data || !("portalTicketId" in lookup.data))
    throw new Error("DISPLAYED_TICKET_LOOKUP_FAILED");
  return { portalTicketId: lookup.data.portalTicketId, code, pairDigits };
}
async function approveDisplayed(
  page: Page,
  id: CaseId,
  created: Awaited<ReturnType<typeof displayedTicket>>,
) {
  const decision = await control(
    id,
    {
      op: "ticket.decide",
      input: {
        actor: "owner",
        portalTicketId: created.portalTicketId,
        decision: "approve",
        pairDigits: created.pairDigits,
      },
    },
    HttpResult,
  );
  expect(decision).toMatchObject({ httpStatus: 200, error: null, data: { status: "approved" } });
  await expect(page.getByRole("region", { name: "电脑授权会话" })).toBeVisible();
  await expect(page.getByText(/^8 位登录码：/)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
  await assertCookie(page);
  const state = await page.evaluate(() => window.__LYX_PORTAL_LIVE__.snapshot());
  expect(state).toMatchObject({ authenticated: true, storeId: liveContext().actors.owner.storeId });
  if (!state.portalSessionId) throw new Error("PAGE_SESSION_MISSING");
  return state.portalSessionId;
}

test("portal-login-page-revoke", async ({ page }) => {
  const id = "portal-login-page-revoke";
  const created = await displayedTicket(page, id);
  await shot(page, "login-pending");
  const sessionId = await approveDisplayed(page, id, created);
  const readWindow = await control(id, { op: "facts.beginRead", input: {} }, ReadWindow);
  expect(
    await control(id, { op: "session.list", input: { actor: "owner" } }, HttpResult),
  ).toMatchObject({
    httpStatus: 200,
    error: null,
    data: {
      items: [
        {
          portalSessionId: sessionId,
          storeId: liveContext().actors.owner.storeId,
          revokedAt: null,
        },
      ],
    },
  });
  expect(
    await control(id, { op: "session.list", input: { actor: "clerk" } }, HttpResult),
  ).toMatchObject({ httpStatus: 403, error: "ROLE_FORBIDDEN", data: null });
  expect(
    await control(id, { op: "session.list", input: { actor: "otherOwner" } }, HttpResult),
  ).toMatchObject({ httpStatus: 200, data: { items: [] } });
  expect(
    await control(
      id,
      { op: "facts.endRead", input: { windowId: readWindow.windowId } },
      ReadResult,
    ),
  ).toEqual({ unchanged: true, changedTables: [] });
  await shot(page, "login-authorized");
  expect(
    await control(
      id,
      { op: "session.revoke", input: { actor: "owner", portalSessionId: sessionId } },
      HttpResult,
    ),
  ).toMatchObject({ httpStatus: 200, error: null, data: { portalSessionId: sessionId } });
  expect(
    await control(id, { op: "session.list", input: { actor: "owner" } }, HttpResult),
  ).toMatchObject({ httpStatus: 200, data: { items: [] } });
  const revokedReadWindow = await control(id, { op: "facts.beginRead", input: {} }, ReadWindow);
  await page.getByRole("button", { name: "刷新授权状态", exact: true }).click();
  await expect(page.getByText("门店老板已撤销这台电脑的授权", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.snapshot())).toMatchObject({
    authenticated: false,
    httpStatus: 401,
    reason: "revoked",
    revokeReason: "owner_revoked",
  });
  await expect(page.getByText("门店老板已撤销这台电脑的授权", { exact: true })).toBeVisible();
  expect(
    await control(
      id,
      { op: "facts.endRead", input: { windowId: revokedReadWindow.windowId } },
      ReadResult,
    ),
  ).toEqual({ unchanged: true, changedTables: [] });
  await expect(page.getByRole("button", { name: "退出电脑授权", exact: true })).toHaveCount(0);
  await shot(page, "login-revoked");
});

test("portal-login-page-reject-refresh", async ({ page }) => {
  const id = "portal-login-page-reject-refresh";
  const created = await displayedTicket(page, id);
  expect(
    await control(
      id,
      {
        op: "ticket.decide",
        input: { actor: "owner", portalTicketId: created.portalTicketId, decision: "reject" },
      },
      HttpResult,
    ),
  ).toMatchObject({ httpStatus: 200, data: { status: "rejected", rejectReason: "by_owner" } });
  await expect(page.getByText("此次登录已被拒绝，请重新生成登录码", { exact: true })).toBeVisible();
  expect((await page.context().cookies()).length).toBe(0);
  await shot(page, "login-rejected");
  await page.getByRole("button", { name: "刷新登录码", exact: true }).click();
  await expect(page.getByText(/^8 位登录码：/)).not.toHaveText(`8 位登录码：${created.code}`);
  const fresh = await displayedTicket(page, id);
  expect(fresh.portalTicketId).not.toBe(created.portalTicketId);
  await shot(page, "login-refreshed");
  await approveDisplayed(page, id, fresh);
  await page.getByRole("button", { name: "退出电脑授权", exact: true }).click();
  await expect(page.getByText("当前电脑尚未授权或授权已失效", { exact: true })).toBeVisible();
  expect((await page.context().cookies()).length).toBe(0);
  expect(
    await control(id, { op: "session.list", input: { actor: "owner" } }, HttpResult),
  ).toMatchObject({ httpStatus: 200, data: { items: [] } });
  await shot(page, "login-logout");
  // Same document navigation mounts the actual public leaf without another authorization request.
  const publicRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/portal/")) publicRequests.push(path);
  });
  await page.evaluate(() => {
    window.history.pushState(null, "", "/a");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "请在狸有戏小程序中授权" })).toBeVisible();
  await shot(page, "login-landing");
  expect(publicRequests).toEqual([]);
  expect((await control(id, { op: "facts.tickets", input: {} }, Facts)).items).toEqual([
    {
      portalTicketId: created.portalTicketId,
      storedStatus: "rejected",
      sessionIds: [],
      activeSessionCount: 0,
    },
    {
      portalTicketId: fresh.portalTicketId,
      storedStatus: "consumed",
      sessionIds: [expect.any(String)],
      activeSessionCount: 0,
    },
  ]);
});
