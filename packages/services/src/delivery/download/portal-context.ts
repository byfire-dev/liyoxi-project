import type { Assembly, Clock, Tx, TxRunner } from "../../kernel/index.js";
import type { PortalPrincipal } from "../../identity/index.js";
import type { Media } from "../../media/index.js";

export interface PortalDeliveryDownloadDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly media: Pick<
    Media,
    "signDeliveryDownload" | "signRead" | "ensureZip" | "readZipSourceFiles"
  >;
  readonly assertPortalPrincipal: (
    tx: Tx,
    principal: PortalPrincipal,
    now: Date,
    options?: { write?: boolean },
  ) => Promise<PortalPrincipal>;
}
