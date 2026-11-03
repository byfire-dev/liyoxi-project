import type { Flow } from "../flow/index.js";
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
import type { Profile } from "../profile/index.js";
import type { Sla } from "../sla/index.js";
import type { StoreMembership } from "../tenant/index.js";
import type { Publish } from "../publish/index.js";
import type { Approval } from "../approval/index.js";
import type { StaffContext } from "../authz/index.js";
import type { AdOrderReferenceReader } from "./ad-order-reference.types.js";

export interface DeliveryCoreDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly flow: Flow;
  readonly events: Pick<Events, "emit">;
  readonly sla: Sla;
  readonly media?: Pick<Media, "link" | "release">;
  readonly approval?: Pick<Approval, "withdraw">;
  readonly ensureLicenseReadiness?: (
    tx: Tx,
    orderItemIds: readonly string[],
    triggerRef: string,
  ) => Promise<readonly { orderItemId: string; ready: boolean; blockers: readonly string[] }[]>;
}
export interface DeliveryDeps extends DeliveryCoreDeps {
  readonly adOrderReferences?: AdOrderReferenceReader;
  readonly reopenAdFree?: (
    tx: Tx,
    actor: { ctx: IdentityContext; staff: StaffContext },
    input: {
      adId: string;
      onVersionNo: number;
      note: string;
      screenshotFileIds: readonly string[];
    },
  ) => Promise<{ revisionNo: number }>;
  readonly media: Pick<
    Media,
    "signRead" | "link" | "release" | "prepareDeliveryProduction" | "deliveryProductionFacts"
  >;
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
