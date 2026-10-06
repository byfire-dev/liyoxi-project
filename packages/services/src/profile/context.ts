import type { Approval } from "../approval/index.js";
import type { Events } from "../events/index.js";
import type {
  Assembly,
  Clock,
  IdentityContext,
  IdempotencyContext,
  TxRunner,
} from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Keyring } from "../security/index.js";
import type { StoreMembership, Tenant } from "../tenant/index.js";
import type { SessionPrincipal } from "../identity/index.js";
import type { WechatProvider } from "../providers/types.js";

export interface ProfileDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly tenant: Tenant;
  readonly approval: Approval;
  readonly events: Events;
  readonly media: Pick<Media, "link" | "release" | "signRead">;
  readonly keyring: () => Keyring;
  readonly wechat: Pick<WechatProvider, "checkText">;
  readonly currentOpenid: (principal: SessionPrincipal) => Promise<string>;
}
export interface ProfileViewer {
  readonly ctx: IdentityContext;
  readonly membership: StoreMembership;
  readonly principal: SessionPrincipal;
}
export interface WriteOptions {
  readonly idem?: IdempotencyContext;
}

export const metaOf = (ctx: IdentityContext) => ({
  requestId: ctx.requestId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  authMethod: null,
  sessionId: null,
});
