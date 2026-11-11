import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { LiveReply } from "./browser-session";
import { Cases, HttpResult, control, liveContext, type CaseId } from "./control-client";
export type ShotName =
  | "session-ready"
  | "session-revoked"
  | "session-logout"
  | "ticket-rejected"
  | "ad-initial"
  | "ad-playing"
  | "ad-version-changed"
  | "ad-channel-unavailable"
  | "sample-q9"
  | "ad-cross-store"
  | "ad-revoked"
  | "verify-current"
  | "verify-pending"
  | "verify-outdated"
  | "verify-revision-missing"
  | "verify-expired"
  | "verify-voided"
  | "verify-invalid"
  | "ad-expired"
  | "ad-renewed";
export function data<T>(reply: LiveReply<T>): T {
  if (!reply.ok) throw new Error(`BROWSER_ACTION_FAILED_${reply.httpStatus}`);
  return reply.data;
}
export function caseId(title: string): CaseId {
  if (!(Cases as readonly string[]).includes(title)) throw new Error("LIVE_CASE_INVALID");
  return title as CaseId;
}
export async function shot(page: Page, name: ShotName, publicPage = false) {
  const privacy = await page.evaluate(
    (isPublic) =>
      isPublic ? window.__LYX_PORTAL_LIVE__.publicPrivacy() : window.__LYX_PORTAL_LIVE__.privacy(),
    publicPage,
  );
  if (publicPage) {
    expect(privacy.observedTicketSecret).toBe(false);
    expect(
      Object.entries(privacy)
        .filter(([key]) => key !== "observedTicketSecret")
        .every(([, value]) => value === true),
    ).toBe(true);
    expect((await page.context().cookies()).length).toBe(0);
  } else expect(Object.values(privacy).every((value) => value === true)).toBe(true);
  const { stageDirectory } = liveContext();
  await page.screenshot({ path: join(stageDirectory, `${name}.png`), animations: "disabled" });
  await writeFile(
    join(stageDirectory, `${name}.privacy.json`),
    `${JSON.stringify({ safe: true })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
export async function ticket(page: Page) {
  return data(await page.evaluate(() => window.__LYX_PORTAL_LIVE__.beginTicket()));
}
export async function approve(
  page: Page,
  id: CaseId,
  created: Awaited<ReturnType<typeof ticket>>,
  actor: "owner" | "otherOwner" = "owner",
) {
  const lookup = await control(
    id,
    { op: "ticket.lookup", input: { actor, code: created.shortCode } },
    HttpResult,
  );
  expect(lookup.httpStatus).toBe(200);
  expect(lookup.error).toBeNull();
  expect(lookup.data).toMatchObject({
    portalTicketId: created.portalTicketId,
    storeId: liveContext().actors[actor].storeId,
  });
  const decision = await control(
    id,
    {
      op: "ticket.decide",
      input: {
        actor,
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
    entityId: liveContext().actors[actor].entityId,
    storeId: liveContext().actors[actor].storeId,
  });
  expect(state.portalSessionId).not.toBeNull();
  return state;
}
