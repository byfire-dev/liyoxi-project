// Cross-domain test composition root. Every success comes from the real producers.
import { createPortalSessions } from "../identity/index.js";
import type {
  Identity,
  PhoneLoginInput,
  PortalOwnerRequest,
  RequestMeta,
} from "../identity/index.js";
import { createIdentityContext } from "../kernel/index.js";
import { createPortalTickets, findI31Violations, purgePortalTickets } from "../portal/index.js";
import type { PortalTicketDeps } from "../portal/index.js";
import type { Tenant } from "../tenant/index.js";

export function createPortalTestStack(deps: PortalTicketDeps) {
  return {
    tickets: createPortalTickets(deps),
    sessions: createPortalSessions(deps),
    checkTickets: () => deps.tx.run(findI31Violations),
    purgeTickets: (limit: number) =>
      deps.tx.run((tx) => purgePortalTickets(tx, { now: deps.clock.now(), limit })),
  };
}

export async function createPortalTestOwner(
  deps: {
    identity: Pick<Identity, "phoneLogin" | "authenticate">;
    tenant: Pick<Tenant, "createEntity">;
  },
  meta: RequestMeta,
  input: PhoneLoginInput,
): Promise<PortalOwnerRequest> {
  const login = await deps.identity.phoneLogin(meta, input);
  const checked = await deps.identity.authenticate(login.token, { ip: meta.ip });
  if (!checked.ok) throw new Error("真实登录失败");
  const actor = {
    type: "merchant" as const,
    client: "weapp" as const,
    id: checked.principal.merchantUserId,
    role: "owner" as const,
  };
  const membership = await deps.tenant.createEntity(createIdentityContext({ actor, ...meta }));
  return {
    principal: checked.principal,
    ctx: createIdentityContext({
      actor,
      ...meta,
      entityId: membership.entityId,
      storeId: membership.storeId,
    }),
  };
}

export async function createPortalTestSession(
  stack: ReturnType<typeof createPortalTestStack>,
  owner: PortalOwnerRequest,
  meta: RequestMeta,
) {
  const ticket = await stack.tickets.create(meta);
  await stack.tickets.decide(owner, ticket.portalTicketId, ticket.pairDigits);
  const exchanged = await stack.tickets.exchange(ticket.portalTicketId, ticket.pollSecret, meta);
  if (!exchanged.token || !exchanged.result.session) throw new Error("真实换会话失败");
  return { ticket, token: exchanged.token, session: exchanged.result.session, ...stack };
}
