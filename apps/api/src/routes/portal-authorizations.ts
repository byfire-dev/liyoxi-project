import {
  PortalTicketPreviewSchema,
  PortalTicketDecisionSchema,
  PortalSessionListSchema,
  PortalSessionItemSchema,
  mPortalTicketLookup,
  mPortalTicketApprove,
  mPortalTicketReject,
  mPortalSessionList,
  mPortalSessionRevoke,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { PortalOwnerRequest } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

function ownerOf(c: Context<ApiEnv>): PortalOwnerRequest {
  const ctx = c.get("identity");
  if (!ctx) throw new AppError("AUTH_REQUIRED");
  c.header("Cache-Control", "no-store");
  return { ctx, principal: merchantSessionOf(c) };
}
export const portalAuthorizationHandlers = [
  defineHandler(mPortalTicketLookup, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).portalTickets.lookup(
      ownerOf(c),
      c.req.valid("query").code,
    );
    return respondByRole(c, { owner: PortalTicketPreviewSchema }, result);
  }),
  defineHandler(mPortalTicketApprove, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).portalTickets.decide(
      ownerOf(c),
      c.req.valid("param").portalTicketId,
      c.req.valid("json").pairDigits,
      { idem: idemOf(c) },
    );
    return respondByRole(c, { owner: PortalTicketDecisionSchema }, result);
  }),
  defineHandler(mPortalTicketReject, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).portalTickets.decide(
      ownerOf(c),
      c.req.valid("param").portalTicketId,
      null,
      { idem: idemOf(c) },
    );
    return respondByRole(c, { owner: PortalTicketDecisionSchema }, result);
  }),
  defineHandler(mPortalSessionList, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).portalSessions.list(ownerOf(c));
    return respondByRole(c, { owner: PortalSessionListSchema }, result);
  }),
  defineHandler(mPortalSessionRevoke, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).portalSessions.revoke(
      ownerOf(c),
      c.req.valid("param").portalSessionId,
      { idem: idemOf(c) },
    );
    return respondByRole(c, { owner: PortalSessionItemSchema }, result);
  }),
];
