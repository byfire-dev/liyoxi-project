import type { Content } from "../content/index.js";
import type { Docs } from "../docs/index.js";
import type { Events } from "../events/index.js";
import type { Assembly, BizNoIssuer, Clock, IdentityContext, TxRunner } from "../kernel/index.js";
import type { Ledger } from "../billing/index.js";
import type { Media } from "../media/index.js";
import type { StoreMembership } from "../tenant/index.js";
import type { Timers } from "../timers/index.js";
import type { Config } from "../config/index.js";
export interface OrderActor {
  ctx: IdentityContext;
  membership: StoreMembership;
}
export interface OrderDeps {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  bizNo: BizNoIssuer;
  ledger: Ledger;
  docs: Docs;
  content: Content;
  media: Pick<Media, "signRead" | "link">;
  events: Events;
  timers: Timers;
  config: Config;
}
