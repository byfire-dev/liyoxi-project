import type { Approval } from "../approval/index.js";
import type { Events } from "../events/index.js";
import type {
  Assembly,
  Clock,
  IdentityContext,
  IdempotencyContext,
  TxRunner,
  Tx,
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
  readonly media: Pick<Media, "link" | "release" | "signRead"> &
    Partial<Pick<Media, "assets" | "ocr">>;
  readonly keyring: () => Keyring;
  readonly wechat: Pick<WechatProvider, "checkText">;
  readonly currentOpenid: (principal: SessionPrincipal) => Promise<string>;
  /** 员工代改只消费当前主体实际老板的近2h微信身份；composition注入identity正式只读公口。 */
  readonly proxyOpenid?: (
    tx: Tx,
    userId: string,
    now: Date,
  ) => Promise<{ readonly wechatIdentityId: string; readonly openid: string } | null>;
  readonly contactSms?: {
    available(tx: Tx): Promise<boolean>;
    assertSession(tx: Tx, principal: SessionPrincipal, at: Date): Promise<unknown>;
    send(phone: string, code: string, directKey: string): Promise<{ status: string }>;
  };
}
export interface ProfileViewer {
  readonly ctx: IdentityContext;
  readonly membership: StoreMembership;
  readonly principal: SessionPrincipal;
}
/** 生命周期订阅不需要商家审核、openid、密钥或自行开事务。 */
export interface ProfileLifecycleDeps {
  readonly clock: Clock;
  readonly tenant: Pick<Tenant, "setStoreQualification">;
  readonly approval: Pick<Approval, "withdraw">;
  readonly events: Pick<Events, "emit">;
  readonly media: Pick<Media, "link" | "release" | "readRefRetention">;
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
