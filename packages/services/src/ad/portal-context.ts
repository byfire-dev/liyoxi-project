import type { assertPortalPrincipal } from "../identity/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import type { Media } from "../media/index.js";

export interface PortalAdDeps {
  tx: TxRunner;
  clock: Clock;
  assertPortalPrincipal: typeof assertPortalPrincipal;
  media: Pick<Media, "signRead" | "adProductionFacts">;
  playback(entityId: string): Promise<boolean>;
}
