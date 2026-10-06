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
import type { Publish } from "../publish/index.js";

export interface DeliveryCoreDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly flow: Flow;
  readonly events: Pick<Events, "emit">;
  readonly sla: Sla;
  readonly media?: Pick<Media, "link">;
}
export interface DeliveryDeps extends DeliveryCoreDeps {
  readonly media: Pick<Media, "signRead" | "link" | "release">;
  readonly profile: Pick<Profile, "assignDeliveryManager">;
  readonly samplePlayback?: (entityId: string) => Promise<boolean>;
  readonly publish?: Pick<Publish, "createLaunchTasks">;
}
export interface DeliveryViewer {
  readonly ctx: IdentityContext;
  readonly membership: StoreMembership;
}
export interface DeliveryWriteOptions {
  readonly idem?: IdempotencyContext;
}
