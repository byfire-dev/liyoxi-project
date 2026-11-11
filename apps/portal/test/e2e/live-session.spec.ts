import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { isErrorSymbol } from "@liyoxi/contract/errors";
import type { LiveSessionState } from "./browser-session";
import { data, caseId, shot, ticket, approve } from "./live-helpers";
import {
  CaseClosed,
  CaseReady,
  Facts,
  HttpResult,
  ReadResult,
  ReadWindow,
  control,
  liveContext,
  type CaseId,
} from "./control-client";

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
  await page.goto("/__portal-live/session");
  await expect(page.getByTestId("portal-live-ready")).toBeVisible();
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
