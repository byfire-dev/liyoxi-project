import type { Config } from "../../config/index.js";
import type { Docs } from "../../docs/index.js";
import type { Events } from "../../events/index.js";
import type { Flow } from "../../flow/index.js";
import type {
  Assembly,
  BizNoIssuer,
  Clock,
  IdentityContext,
  TxRunner,
  Tx,
} from "../../kernel/index.js";
import type { Media } from "../../media/index.js";
import type { Keyring } from "../../security/index.js";
import type { Sla } from "../../sla/index.js";
import type { StoreMembership, Tenant } from "../../tenant/index.js";
import type { Timers } from "../../timers/index.js";
import type { Ledger } from "../ledger/index.js";
import type { WechatPayProvider } from "../../providers/types.js";
import type { Approval } from "../../approval/index.js";
import type { Payment } from "./types.js";
export interface WechatPayerSession {
  readonly sessionId: string;
  readonly merchantUserId: string;
  readonly wechatIdentityId: string;
  readonly consentStamp: string | null;
}
export interface BillingPurchaseDeps {
  wechatPay?: {
    provider: WechatPayProvider;
    appid: string;
    mchid: string;
    currentOpenid: (tx: Tx, session: WechatPayerSession) => Promise<string>;
  };
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  config: Config;
  flow: Flow;
  events: Events;
  timers: Timers;
  bizNo: BizNoIssuer;
  media: Pick<Media, "link"> & Partial<Pick<Media, "enqueueBankReceiptOcr" | "readBankReceiptOcr">>;
  docs: Docs;
  tenant: Tenant;
  keyring: () => Keyring;
  ledger: Ledger;
  payment: Payment;
  /** 实际组合根注入；旧单域构造可省略，但不能处理二人复核。 */
  approval?: Approval;
  sla: Sla;
}
export interface PurchaseActor {
  ctx: IdentityContext;
  membership: StoreMembership;
}
