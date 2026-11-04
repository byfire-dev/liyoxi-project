import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "@liyoxi/services";
import type { PortalLiveFixture } from "@liyoxi/services/testing";
import type { PortalLiveMerchant } from "./portal-shell-live-merchant.js";
import {
  assertPortalControlPath,
  createPortalLiveControl,
  PortalControlCommandSchema,
} from "./portal-shell-live-control.js";
import { PortalLiveParentMessageSchema } from "./portal-shell-live-server.js";

const ticket = uuidv7(),
  session = uuidv7(),
  owner = uuidv7(),
  store = uuidv7(),
  entity = uuidv7();
const preview = {
  playbackAuditCount: 0,
  ad: { adId: uuidv7(), versionNo: 1 },
  license: {
    verifyCode: "public-verify-code",
    revNo: 1,
    pendingRevNo: null,
    displayStatus: "effective" as const,
    expiredVerifyCode: "public-expired-code",
    unissuedVerifyCode: "public-unissued-code",
  },
};
function setup() {
  const fixture = {
    ticketFacts: vi.fn<PortalLiveFixture["ticketFacts"]>().mockResolvedValue([
      {
        portalTicketId: ticket,
        storedStatus: "consumed",
        sessions: [
          {
            portalSessionId: session,
            approvedByUserId: owner,
            storeId: store,
            entityId: entity,
            revoked: false,
          },
        ],
      },
    ]),
    beginReadWindow: vi.fn().mockResolvedValue(randomUUID()),
    endReadWindow: vi.fn().mockResolvedValue({ unchanged: true, changedTables: [] }),
    discardReadWindow: vi.fn().mockReturnValue(false),
    preparePreview: vi.fn<PortalLiveFixture["preparePreview"]>().mockResolvedValue(preview),
    previewAction: vi.fn<PortalLiveFixture["previewAction"]>().mockResolvedValue(preview),
    previewFacts: vi.fn<PortalLiveFixture["previewFacts"]>().mockResolvedValue(preview),
  };
  const merchant = {
    lookup: vi.fn<PortalLiveMerchant["lookup"]>().mockResolvedValue({
      httpStatus: 200,
      error: null,
      data: {
        portalTicketId: ticket,
        pairChoices: ["10", "20", "30"],
        storeId: store,
        storeName: "fixture",
        browser: "fixture browser",
        regionHint: null,
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-01T00:02:00Z",
      },
    }),
    decide: vi.fn<PortalLiveMerchant["decide"]>().mockResolvedValue({
      httpStatus: 200,
      error: null,
      data: {
        portalTicketId: ticket,
        status: "approved",
        rejectReason: null,
        approvedAt: "2026-01-01T00:00:00Z",
        storeId: store,
      },
    }),
    revoke: vi.fn<PortalLiveMerchant["revoke"]>().mockResolvedValue({
      httpStatus: 200,
      error: null,
      data: {
        portalSessionId: session,
        storeId: store,
        storeName: "fixture",
        grantScope: "store",
        browser: "fixture",
        regionHint: null,
        authorizedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-01T02:00:00Z",
        revokedAt: "2026-01-01T00:01:00Z",
      },
    }),
    actorForUser: vi
      .fn<PortalLiveMerchant["actorForUser"]>()
      .mockImplementation((id) => (id === owner ? "owner" : undefined)),
    previewScopes: vi.fn<PortalLiveMerchant["previewScopes"]>().mockReturnValue({
      owner: { merchantUserId: owner, entityId: entity, storeId: store },
      clerk: { merchantUserId: uuidv7(), entityId: entity, storeId: store },
      otherOwner: { merchantUserId: uuidv7(), entityId: uuidv7(), storeId: uuidv7() },
    }),
  };
  const control = createPortalLiveControl(fixture, merchant);
  const send = (op: string, input = {}, extra = {}) =>
    control.dispatch({ v: 1, id: randomUUID(), caseId: "one", op, input, ...extra });
  return {
    fixture,
    merchant,
    control,
    send,
    async register() {
      await send("case.begin");
      await send("ticket.lookup", { actor: "owner", code: "12345678" });
    },
  };
}

describe("portal private control: authority and safe output", () => {
  it("prepares preview only explicitly in an active case using internal HTTP identities and safe facts", async () => {
    const h = setup();
    expect(await h.send("preview.prepare")).toMatchObject({
      ok: false,
      failure: { code: "WRONG_CASE" },
    });
    await h.send("case.begin");
    expect(h.fixture.preparePreview).not.toHaveBeenCalled();
    h.fixture.preparePreview.mockResolvedValue({
      ...preview,
      license: { ...preview.license, pdfUrl: "private-object-sentinel" },
      merchantUserId: owner,
      token: "credential-sentinel",
    } as typeof preview);
    expect(await h.send("preview.prepare")).toMatchObject({ ok: true, result: preview });
    expect(h.fixture.preparePreview).toHaveBeenCalledExactlyOnceWith(
      h.merchant.previewScopes.mock.results[0]!.value,
    );
    const reply = await h.send("preview.action", { action: "push-ad-version" });
    expect(reply).toMatchObject({ ok: true, result: preview });
    expect(h.fixture.previewAction).toHaveBeenCalledExactlyOnceWith("push-ad-version");
    const prepared = await h.send("preview.prepare");
    expect(prepared).toEqual({ v: 1, id: expect.any(String), ok: true, result: preview });
    for (const value of ["private-object-sentinel", "credential-sentinel", owner])
      expect(JSON.stringify(prepared)).not.toContain(value);
  });
  it("rejects arbitrary preview actors, scope, paths, time and flag commands before any producer", async () => {
    const h = setup();
    await h.send("case.begin");
    for (const input of [{ actor: "owner" }, { merchantUserId: owner }, { storeId: store }])
      expect(await h.send("preview.prepare", input)).toMatchObject({
        ok: false,
        failure: { code: "BAD_COMMAND" },
      });
    for (const input of [
      { action: "set-clock", now: "2026-01-01" },
      { action: "expire-media-grants", seconds: 1 },
      { action: "ad-channel-unavailable", flag: "arbitrary" },
      { action: "push-ad-version", path: "/private" },
    ])
      expect(await h.send("preview.action", input)).toMatchObject({
        ok: false,
        failure: { code: "BAD_COMMAND" },
      });
    expect(h.merchant.previewScopes).not.toHaveBeenCalled();
    expect(h.fixture.preparePreview).not.toHaveBeenCalled();
    expect(h.fixture.previewAction).not.toHaveBeenCalled();
  });
  it("blocks every preview write during read evidence and does not leak or retry producer failures", async () => {
    const h = setup();
    await h.send("case.begin");
    await h.send("facts.beginRead");
    expect(await h.send("preview.prepare")).toMatchObject({
      ok: false,
      failure: { code: "BAD_COMMAND" },
    });
    for (const action of [
      "push-ad-version",
      "queue-license-correction",
      "complete-license-correction",
      "void-license",
      "expire-media-grants",
      "ad-channel-unavailable",
      "ad-channel-available",
    ])
      expect(await h.send("preview.action", { action })).toMatchObject({
        ok: false,
        failure: { code: "BAD_COMMAND" },
      });
    expect(h.fixture.preparePreview).not.toHaveBeenCalled();
    expect(h.fixture.previewAction).not.toHaveBeenCalled();
    expect(await h.send("preview.facts")).toMatchObject({ ok: true, result: preview });
    expect(h.fixture.previewFacts).toHaveBeenCalledTimes(1);
    const windowId = await h.fixture.beginReadWindow.mock.results[0]!.value;
    await h.send("facts.endRead", { windowId });
    h.fixture.previewAction.mockRejectedValue(new Error("private-provider-sentinel"));
    const reply = await h.send("preview.action", { action: "ad-channel-unavailable" });
    expect(reply).toMatchObject({ ok: false, failure: { code: "CONTROL_FAILED" } });
    expect(JSON.stringify(reply)).not.toContain("private-provider-sentinel");
    expect(h.fixture.previewAction).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown fields and fake auth commands without echoing their input", async () => {
    const h = setup(),
      secret = "pollSecret-sentinel-should-never-be-in-output";
    for (const raw of [
      { v: 1, id: secret, caseId: "one", op: "case.begin", input: {} },
      { v: 1, id: randomUUID(), caseId: "one", op: "getToken", input: {} },
      { v: 1, id: randomUUID(), caseId: "one", op: "case.begin", input: { token: secret } },
    ]) {
      const reply = await h.control.dispatch(raw);
      expect(reply).toMatchObject({ ok: false, failure: { code: "BAD_COMMAND" } });
      expect(JSON.stringify(reply)).not.toContain(secret);
    }
    expect(h.merchant.lookup).not.toHaveBeenCalled();
  });
  it("requires the current case and a registered ticket before invoking a write", async () => {
    const h = setup();
    expect(
      await h.send("ticket.decide", { actor: "owner", portalTicketId: ticket, decision: "reject" }),
    ).toMatchObject({ ok: false, failure: { code: "WRONG_CASE" } });
    await h.send("case.begin");
    expect(
      await h.send("ticket.decide", { actor: "owner", portalTicketId: ticket, decision: "reject" }),
    ).toMatchObject({ ok: false, failure: { code: "NOT_OWNED" } });
    expect(h.merchant.decide).not.toHaveBeenCalled();
  });
  it("does not simulate a clerk/other-owner rejection or turn rejected decisions into approval", async () => {
    const h = setup();
    await h.register();
    h.merchant.revoke.mockResolvedValue({ httpStatus: 403, error: "ROLE_FORBIDDEN", data: null });
    expect(
      await h.send("session.revoke", { actor: "otherOwner", portalSessionId: session }),
    ).toMatchObject({ ok: true, result: { httpStatus: 403, error: "ROLE_FORBIDDEN", data: null } });
    expect(h.merchant.revoke.mock.calls[0]?.slice(0, 2)).toEqual(["otherOwner", session]);
    h.merchant.decide.mockResolvedValue({
      httpStatus: 200,
      error: null,
      data: {
        portalTicketId: ticket,
        status: "rejected",
        rejectReason: "pair_mismatch",
        approvedAt: null,
        storeId: null,
      },
    });
    expect(
      await h.send("ticket.decide", {
        actor: "owner",
        portalTicketId: ticket,
        decision: "approve",
        pairDigits: "99",
      }),
    ).toMatchObject({
      ok: true,
      result: { data: { status: "rejected", rejectReason: "pair_mismatch" } },
    });
  });
  it("sends retries to real HTTP with one key, rejects mutated intent, and never auto-retries", async () => {
    const h = setup();
    await h.register();
    const id = randomUUID(),
      input = { actor: "owner", portalTicketId: ticket, decision: "approve", pairDigits: "10" };
    await h.send("ticket.decide", input, { id });
    await h.send("ticket.decide", input, { id });
    expect(h.merchant.decide).toHaveBeenCalledTimes(2);
    expect(h.merchant.decide.mock.calls[0]?.[2]).toBe(h.merchant.decide.mock.calls[1]?.[2]);
    expect(await h.send("ticket.decide", { ...input, pairDigits: "20" }, { id })).toMatchObject({
      ok: false,
      failure: { code: "BAD_COMMAND" },
    });
    expect(h.merchant.decide).toHaveBeenCalledTimes(2);
    h.merchant.decide.mockRejectedValue(new Error("Bearer secret-sentinel"));
    const failed = await h.send("ticket.decide", input);
    expect(failed).toMatchObject({ ok: false, failure: { code: "CONTROL_FAILED" } });
    expect(JSON.stringify(failed)).not.toContain("secret-sentinel");
    expect(h.merchant.decide).toHaveBeenCalledTimes(3);
  });
  it("projects facts without authorizer identity and prevents writes within a read window", async () => {
    const h = setup();
    await h.register();
    const facts = await h.send("facts.tickets");
    expect(facts).toMatchObject({
      ok: true,
      result: { items: [{ sessionIds: [session], activeSessionCount: 1 }] },
    });
    expect(JSON.stringify(facts)).not.toContain(owner);
    await h.send("facts.beginRead");
    expect(
      await h.send("session.revoke", { actor: "owner", portalSessionId: session }),
    ).toMatchObject({ ok: false, failure: { code: "BAD_COMMAND" } });
    expect(h.merchant.revoke).not.toHaveBeenCalled();
  });
  it("cleans a failed case with an open window using the actual authorizer and marks abandonment", async () => {
    const h = setup();
    await h.register();
    await h.send("facts.beginRead");
    h.fixture.discardReadWindow.mockReturnValue(true);
    expect(await h.send("case.end")).toMatchObject({
      ok: true,
      result: { closed: true, abandonedReadWindow: true },
    });
    expect(h.merchant.revoke.mock.calls[0]?.slice(0, 2)).toEqual(["owner", session]);
    expect(await h.send("case.begin", {}, { caseId: "two" })).toMatchObject({ ok: true });
  });
  it("serializes commands through an observable pending operation", async () => {
    const h = setup();
    await h.send("case.begin");
    const original = await h.merchant.lookup("owner", "12345678");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.merchant.lookup.mockImplementation(async () => {
      await barrier;
      return original;
    });
    const lookup = h.send("ticket.lookup", { actor: "owner", code: "12345678" });
    const decide = h.send("ticket.decide", {
      actor: "owner",
      portalTicketId: ticket,
      decision: "reject",
    });
    expect(h.merchant.decide).not.toHaveBeenCalled();
    release();
    await lookup;
    await decide;
    expect(h.merchant.decide).toHaveBeenCalledTimes(1);
  });
});

describe("private startup and filesystem boundary", () => {
  const owned: string[] = [];
  afterEach(async () => {
    for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
  });
  it("rejects extra startup secrets and forbids pair digits on rejection", () => {
    const start = {
      v: 1,
      type: "start",
      runId: "012345abcdef",
      portalOrigin: "https://portal.localhost:4000",
      version: "test",
      controlSocketPath: "/tmp/lyx-portal-012345abcdef/control.sock",
    };
    expect(PortalLiveParentMessageSchema.safeParse(start).success).toBe(true);
    expect(PortalLiveParentMessageSchema.safeParse({ ...start, token: "private" }).success).toBe(
      false,
    );
    expect(
      PortalControlCommandSchema.safeParse({
        v: 1,
        id: randomUUID(),
        caseId: "one",
        op: "ticket.decide",
        input: { actor: "owner", portalTicketId: ticket, decision: "reject", pairDigits: "10" },
      }).success,
    ).toBe(false);
  });
  it("only accepts the canonical owned 0700 directory and does not overwrite an existing socket path", async () => {
    const runId = randomUUID().replaceAll("-", "").slice(0, 12),
      tmp = await realpath("/tmp");
    const directory = join(tmp, `lyx-portal-${runId}`),
      socket = join(directory, "control.sock");
    await mkdir(directory, { mode: 0o700 });
    owned.push(directory);
    await expect(assertPortalControlPath(runId, socket)).resolves.toBeUndefined();
    await chmod(directory, 0o755);
    await expect(assertPortalControlPath(runId, socket)).rejects.toThrow("INVALID_CONTROL_PATH");
    await chmod(directory, 0o700);
    await writeFile(socket, "owned sentinel");
    await expect(assertPortalControlPath(runId, socket)).rejects.toThrow("CONTROL_PATH_EXISTS");
    const otherId = `${runId.slice(0, 11)}${runId.endsWith("0") ? "1" : "0"}`;
    const alternate = join(tmp, `lyx-portal-${otherId}`);
    await symlink(directory, alternate);
    owned.push(alternate);
    await expect(assertPortalControlPath(otherId, join(alternate, "control.sock"))).rejects.toThrow(
      "INVALID_CONTROL_PATH",
    );
  });
});
