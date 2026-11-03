// Private, per-read preparation; capabilities never enter the replay spec or public report.
import { randomUUID } from "node:crypto";
import {
  LicenseLetterDetailSchema,
  LicenseLetterPageSchema,
  NoDataSchema,
  PortalTicketCreatedSchema,
  PortalTicketDecisionSchema,
  PortalTicketExchangeResultSchema,
  z,
} from "@liyoxi/contract";
import type { M1Api, M1RequestInit } from "./in-process.js";
import { MixedFailure } from "./mixed-http-driver.protocol.js";
import type { MixedPrivateAccess } from "./mixed-http-driver.protocol.js";

const sessionReads = new Set([
  "portal.session.current.get",
  "portal.orderItem.list",
  "portal.orderItem.release.get",
  "portal.orderItem.publishList.get",
  "portal.ad.list",
  "portal.ad.get",
]);

export async function prepareMixedPortalReads(
  api: Pick<M1Api, "request">,
  input: {
    operationIds: readonly string[];
    merchantHeaders: Readonly<Record<string, string>>;
    licenseScope?: Pick<MixedPrivateAccess["ids"], "orderId" | "orderItemId" | "storeId">;
    origin?: string;
    signal: AbortSignal;
  },
) {
  const lookup = input.operationIds.includes("m.portalTicket.lookup");
  const session = input.operationIds.some((operationId) => sessionReads.has(operationId));
  const verification = input.operationIds.includes("portal.licenseVerification.get");
  const pending = new Set<string>();
  let cookie: string | undefined;
  let closing: Promise<void> | undefined;
  const headers: Record<string, string> = {};
  const request = async <T>(path: string, init: M1RequestInit, schema: z.ZodType<T>) => {
    try {
      const response = await api.request(path, init);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new MixedFailure("read_failed");
      }
      const body = z.object({ data: schema }).parse(await response.json());
      return { response, data: body.data };
    } catch {
      // Preparation writes are not part of the selected GET spec; expose no operation context.
      throw new MixedFailure("read_failed");
    }
  };
  const readVerificationCode = async () => {
    const scope = input.licenseScope;
    if (!scope || !input.origin) throw new MixedFailure("read_failed");
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      input.signal.throwIfAborted();
      const query = new URLSearchParams({
        orderId: scope.orderId,
        storeId: scope.storeId,
        limit: "50",
        ...(cursor ? { cursor } : {}),
      });
      const { data: list } = await request(
        "/api/v1/m/license-letters?" + query,
        { headers: input.merchantHeaders, signal: input.signal },
        LicenseLetterPageSchema,
      );
      const letter = list.items.find(
        (row) =>
          row.orderId === scope.orderId &&
          row.orderItemId === scope.orderItemId &&
          row.storeId === scope.storeId &&
          row.currentRevNo !== null &&
          row.issuedAt !== null &&
          !row.isRendering,
      );
      if (letter) {
        const { data: detail } = await request(
          "/api/v1/m/license-letters/" + encodeURIComponent(letter.licenseLetterId),
          { headers: input.merchantHeaders, signal: input.signal },
          LicenseLetterDetailSchema,
        );
        if (
          detail.licenseLetterId !== letter.licenseLetterId ||
          detail.orderId !== scope.orderId ||
          detail.orderItemId !== scope.orderItemId ||
          detail.storeId !== scope.storeId ||
          !detail.preview ||
          detail.currentRevNo !== detail.preview.revNo ||
          !detail.issuedAt ||
          detail.isRendering
        )
          throw new MixedFailure("read_failed");
        // The completed M1 chain already rendered/signed/issued this version. Only read its URL;
        // do not create a certificate, sign a download, or put its capability in the replay spec.
        try {
          const url = new URL(detail.preview.verifyUrl),
            code = url.searchParams.get("code");
          if (
            url.protocol !== "https:" ||
            url.origin !== new URL(input.origin).origin ||
            url.username ||
            url.password ||
            url.pathname !== "/v" ||
            url.hash ||
            !code ||
            !/^[0-9A-Za-z]{16}$/.test(code) ||
            url.searchParams.get("rev") !== String(detail.preview.revNo) ||
            [...url.searchParams.keys()].sort().join(",") !== "code,rev"
          )
            throw new MixedFailure("read_failed");
          return code;
        } catch {
          throw new MixedFailure("read_failed");
        }
      }
      if (!list.hasMore || !list.nextCursor || cursors.has(list.nextCursor))
        throw new MixedFailure("read_failed");
      cursor = list.nextCursor;
      cursors.add(cursor);
    }
    throw new MixedFailure("read_failed");
  };
  const close = () =>
    (closing ??= (async () => {
      const work: Promise<unknown>[] = [];
      if (cookie)
        work.push(
          request(
            "/api/v1/portal/sessions/current",
            { method: "DELETE", headers: { ...headers, Cookie: cookie } },
            NoDataSchema,
          ),
        );
      for (const portalTicketId of pending)
        work.push(
          request(
            `/api/v1/m/portal-tickets/${portalTicketId}/reject`,
            {
              method: "POST",
              headers: { ...input.merchantHeaders, "Idempotency-Key": randomUUID() },
            },
            PortalTicketDecisionSchema,
          ),
        );
      // Attempt every owned cleanup even if one request fails; never report a failed cleanup green.
      if ((await Promise.allSettled(work)).some((result) => result.status === "rejected"))
        throw new MixedFailure("cleanup_failed");
    })());
  try {
    input.signal.throwIfAborted();
    const licenseVerificationCode = verification ? await readVerificationCode() : "";
    if (!lookup && !session) return { lookupCode: "", licenseVerificationCode, headers, close };
    if (!input.origin) throw new MixedFailure("read_failed");
    headers.Origin = input.origin;
    headers["X-LYX-Portal"] = "1";
    const create = async () => {
      const { data } = await request(
        "/api/v1/portal/portal-tickets",
        { method: "POST", headers, json: {}, signal: input.signal },
        PortalTicketCreatedSchema,
      );
      pending.add(data.portalTicketId);
      return data;
    };
    // lookup requires pending: the consumed login ticket cannot stand in for this separate ticket.
    const lookupTicket = lookup ? await create() : undefined;
    if (session) {
      const ticket = await create();
      const approval = await request(
        `/api/v1/m/portal-tickets/${ticket.portalTicketId}/approve`,
        {
          method: "POST",
          headers: { ...input.merchantHeaders, "Idempotency-Key": randomUUID() },
          json: { pairDigits: ticket.pairDigits },
          signal: input.signal,
        },
        PortalTicketDecisionSchema,
      );
      pending.delete(ticket.portalTicketId);
      if (approval.data.status !== "approved") throw new MixedFailure("read_failed");
      const exchange = await request(
        `/api/v1/portal/portal-tickets/${ticket.portalTicketId}/exchange`,
        {
          method: "POST",
          headers,
          json: { pollSecret: ticket.pollSecret },
          signal: input.signal,
        },
        PortalTicketExchangeResultSchema,
      );
      const issued = exchange.response.headers.get("set-cookie")?.split(";")[0];
      if (
        exchange.data.status !== "consumed" ||
        !exchange.data.session ||
        !issued ||
        !/^__Host-lyx_portal=[A-Za-z0-9_-]{43}$/.test(issued)
      )
        throw new MixedFailure("read_failed");
      cookie = issued;
      headers.Cookie = cookie;
    }
    return { lookupCode: lookupTicket?.shortCode ?? "", licenseVerificationCode, headers, close };
  } catch (error) {
    await close();
    throw error;
  }
}
