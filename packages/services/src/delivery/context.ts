import type { Flow } from "../flow/index.js";
import type { Events } from "../events/index.js";
import type {
  Assembly,
  Clock,
  IdentityContext,
  IdempotencyContext,
  TxRunner,
} from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Profile } from "../profile/index.js";
import type { Sla } from "../sla/index.js";
import type { StoreMembership } from "../tenant/index.js";

export interface DeliveryCoreDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly flow: Flow;
  readonly events: Pick<Events, "emit">;
  readonly sla: Sla;
}
export interface DeliveryDeps extends DeliveryCoreDeps {
  readonly media: Pick<Media, "signRead">;
  readonly profile: Pick<Profile, "assignDeliveryManager">;
}
export interface DeliveryViewer {
  readonly ctx: IdentityContext;
  readonly membership: StoreMembership;
}
export interface DeliveryWriteOptions {
  readonly idem?: IdempotencyContext;
}
