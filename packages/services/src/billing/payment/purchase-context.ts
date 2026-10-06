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
} from "../../kernel/index.js";
import type { Media } from "../../media/index.js";
import type { Keyring } from "../../security/index.js";
import type { Sla } from "../../sla/index.js";
import type { StoreMembership, Tenant } from "../../tenant/index.js";
import type { Timers } from "../../timers/index.js";
import type { Ledger } from "../ledger/index.js";
import type { Payment } from "./types.js";
export interface BillingPurchaseDeps {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  config: Config;
  flow: Flow;
  events: Events;
  timers: Timers;
  bizNo: BizNoIssuer;
  media: Pick<Media, "link">;
  docs: Docs;
  tenant: Tenant;
  keyring: () => Keyring;
  ledger: Ledger;
  payment: Payment;
  sla: Sla;
}
export interface PurchaseActor {
  ctx: IdentityContext;
  membership: StoreMembership;
}
