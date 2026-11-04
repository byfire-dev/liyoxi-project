import { describe, expect, it, vi } from "vitest";

import { createPortalClient } from "../../lib/api";
import { deferred, ok, SESSION } from "../../lib/api.test-helpers";
import { createPortalTicketFlow } from "./api";

const SECRET = "public_test_sentinel_".padEnd(43, "x");
const TICKET = {
  portalTicketId: "019a4500-0000-7000-8000-000000000005",
  qrUrl: "https://portal.example.invalid/a?t=public-id",
  shortCode: "12ABCDEF",
  pairDigits: "17",
  pollSecret: SECRET,
  expiresAt: "2026-11-04T00:02:00.000Z",
  pollIntervalMs: 2000 as const,
};

describe("portal ticket 私有内存闭包", () => {
  it("create只投影公开字段；poll仅秘密头，exchange只一次且不伪造current", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ ...TICKET, unexpectedSecret: SECRET }))
      .mockResolvedValueOnce(
        ok({
          portalTicketId: TICKET.portalTicketId,
          status: "approved",
          expiresAt: TICKET.expiresAt,
        }),
      )
      .mockResolvedValueOnce(ok({ status: "consumed", session: SESSION, rejectReason: null }));
    const flow = createPortalTicketFlow(createPortalClient({ fetch: send }));
    const ticket = await flow.create();
    expect(Object.keys(ticket).sort()).toEqual(
      ["portalTicketId", "qrUrl", "shortCode", "pairDigits", "expiresAt", "pollIntervalMs"].sort(),
    );
    expect(JSON.stringify(ticket)).not.toContain(SECRET);
    await expect(flow.poll()).resolves.toMatchObject({ status: "approved" });
    const [pollUrl, pollOptions] = send.mock.calls[1]!;
    expect(String(pollUrl)).not.toContain(SECRET);
    expect(new Headers(pollOptions?.headers).get("X-Poll-Secret")).toBe(SECRET);
    const first = flow.exchange(),
      second = flow.exchange();
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ status: "consumed", session: SESSION });
    expect(send.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ pollSecret: SECRET }));
    expect(send).toHaveBeenCalledTimes(3);
    await flow.exchange();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.some(([url]) => String(url).includes("sessions/current"))).toBe(false);
  });

  it.each(["rejected", "expired", "consumed"] as const)(
    "票据%s终态清secret并停止后续poll/exchange",
    async (status) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ok(TICKET))
        .mockResolvedValueOnce(
          ok({ portalTicketId: TICKET.portalTicketId, status, expiresAt: TICKET.expiresAt }),
        );
      const flow = createPortalTicketFlow(createPortalClient({ fetch: send }));
      await flow.create();
      await flow.poll();
      await expect(flow.poll()).rejects.toMatchObject({ error: "PORTAL_TICKET_INVALID" });
      await expect(flow.exchange()).rejects.toMatchObject({ error: "PORTAL_TICKET_INVALID" });
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("rejected结果保持未授权；consumed/null不能成为成功授权", async () => {
    for (const result of [
      { status: "rejected", session: null, rejectReason: "window_passed" },
      { status: "consumed", session: null, rejectReason: null },
    ]) {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ok(TICKET))
        .mockResolvedValueOnce(ok(result));
      const flow = createPortalTicketFlow(createPortalClient({ fetch: send }));
      await flow.create();
      if (result.status === "rejected") await expect(flow.exchange()).resolves.toEqual(result);
      else await expect(flow.exchange()).rejects.toMatchObject({ error: "INVALID_RESPONSE" });
    }
  });

  it("重建票据丢弃旧轮迟到结果，dispose后不能poll或恢复secret", async () => {
    const old = deferred<Response>();
    const send = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(ok(TICKET));
    const flow = createPortalTicketFlow(createPortalClient({ fetch: send }));
    const first = flow.create();
    const latest = await flow.create();
    old.resolve(ok({ ...TICKET, shortCode: "ZZZZZZZZ" }));
    await expect(first).rejects.toMatchObject({ error: "REQUEST_ABORTED" });
    expect(latest.shortCode).toBe(TICKET.shortCode);
    flow.dispose();
    await expect(flow.poll()).rejects.toMatchObject({ error: "CLIENT_DISPOSED" });
    expect(JSON.stringify(flow)).not.toContain(SECRET);
  });
});
