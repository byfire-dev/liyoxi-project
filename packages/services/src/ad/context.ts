import type { AD_STATUS, PLACEMENT_SLOT } from "@liyoxi/contract/enums";
import type { StaffContext } from "../authz/index.js";
import type { Ledger } from "../billing/index.js";
import type { Config } from "../config/index.js";
import type { Docs } from "../docs/index.js";
import type { Events } from "../events/index.js";
import type { Flow } from "../flow/index.js";
import type { Assembly, BizNoIssuer, Clock, IdentityContext, TxRunner } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Sla } from "../sla/index.js";
import type { StoreMembership } from "../tenant/index.js";
import type { Timers } from "../timers/index.js";
import type { SessionPrincipal } from "../identity/index.js";
import type { Tx } from "../kernel/index.js";
import type { z } from "zod";
import type {
  AdFloatingPlacementSchema,
  AdRelatedServiceTicketSchema,
  PlayableSchema,
} from "@liyoxi/contract";

export type AdStatus = (typeof AD_STATUS.values)[number];
export type AdSlot = (typeof PLACEMENT_SLOT.values)[number];
export interface AdActor {
  ctx: IdentityContext;
  membership: StoreMembership;
  principal?: SessionPrincipal;
}
export interface AdStaffActor {
  ctx: IdentityContext;
  staff: StaffContext;
}
export interface AdWriteDeps {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  bizNo: BizNoIssuer;
  flow: Flow;
  events: Events;
  ledger: Ledger;
  docs: Docs;
  timers: Timers;
  sla: Sla;
  media: Pick<
    Media,
    "link" | "release" | "signRead" | "signDeliveryDownload" | "adProductionFacts"
  >;
  config: Config;
  /** Text moderation is prepared outside the business transaction, never from a writer. */
  moderate(actor: AdActor, fields: Readonly<Record<string, string>>): Promise<void>;
  playback(entityId: string): Promise<boolean>;
  readPlayable(
    actor: AdActor | undefined,
    playableId: string,
  ): Promise<z.infer<typeof PlayableSchema>>;
  /** Same-owner public readers are composed by ops; ad never reads order/support private tables. */
  related(
    tx: Tx,
    scope: { entityId: string; storeId: string; adId: string },
  ): Promise<{
    usage: { inUseCount: number; firstDramaTitle: string | null };
    floatingPlacements: z.infer<typeof AdFloatingPlacementSchema>[];
    relatedServiceTickets: z.infer<typeof AdRelatedServiceTicketSchema>[];
  }>;
}
export interface AdOrderFact {
  adId: string;
  adNo: string;
  entityId: string;
  storeId: string;
  type: AdSlot;
  durationSec: number;
  copy: string | null;
  status: AdStatus;
  confirmedAt: string | null;
  confirmedVersionNo: number | null;
  openCancelRequestId: string | null;
  confirmedVersion: { versionNo: number; fileId: string; mediaReady: boolean } | null;
}
export interface AdReopenChange {
  adId: string;
  revisionId: string;
  revisionNo: number;
  onVersionNo: number;
  previousConfirmedVersionNo: number | null;
  latestVersionNo: number;
  dueAt: Date;
}
export interface AdConfirmChange {
  adId: string;
  versionNo: number;
  previousConfirmedVersionNo: number | null;
}
export interface AdFreeReopenInput {
  adId: string;
  onVersionNo: number;
  note: string;
  screenshotFileIds: readonly string[];
}
