import {
  PortalTicketCreatedSchema,
  PortalTicketStatusViewSchema,
  PortalTicketExchangeResultSchema,
  PortalSessionViewSchema,
  portalPortalTicketCreate,
  portalPortalTicketGet,
  portalPortalTicketExchange,
  portalSessionCurrentGet,
  portalSessionCurrentDelete,
} from "@liyoxi/contract";
import { ok } from "../http/errors.js";
import { portalCookie, portalPrincipalOf, portalRequestMeta } from "../http/portal-auth.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const portalHandlers = [
  defineHandler(portalPortalTicketCreate, async (c) =>
    ok(
      c,
      PortalTicketCreatedSchema.parse(
        await merchantServicesOf(c.var.runtime).portalTickets.create(portalRequestMeta(c)),
      ),
    ),
  ),
  defineHandler(portalPortalTicketGet, async (c) => {
    const { portalTicketId } = c.req.valid("param");
    const { "x-poll-secret": secret } = c.req.valid("header");
    return ok(
      c,
      PortalTicketStatusViewSchema.parse(
        await merchantServicesOf(c.var.runtime).portalTickets.poll(portalTicketId, secret),
      ),
    );
  }),
  defineHandler(portalPortalTicketExchange, async (c) => {
    const outcome = await merchantServicesOf(c.var.runtime).portalTickets.exchange(
      c.req.valid("param").portalTicketId,
      c.req.valid("json").pollSecret,
      portalRequestMeta(c),
    );
    if (outcome.token !== null) c.header("Set-Cookie", portalCookie(outcome.token));
    return ok(c, PortalTicketExchangeResultSchema.parse(outcome.result));
  }),
  defineHandler(portalSessionCurrentGet, (c) =>
    ok(c, PortalSessionViewSchema.parse(portalPrincipalOf(c).view)),
  ),
  defineHandler(portalSessionCurrentDelete, async (c) => {
    await merchantServicesOf(c.var.runtime).portalSessions.logout(
      portalPrincipalOf(c),
      portalRequestMeta(c),
    );
    c.header("Set-Cookie", portalCookie("", true));
    return ok(c, null);
  }),
];
