import type { Assembly, Clock, TxRunner } from "../../kernel/index.js";
import type { Media } from "../../media/index.js";
export interface DeliveryDownloadDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly media: Pick<Media, "signDeliveryDownload" | "deliveryProductionFacts">;
  readonly samplePlayback?: (entityId: string) => Promise<boolean>;
}
