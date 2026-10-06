import type { Approval } from "../approval/index.js";
import type { Flow } from "../flow/index.js";
import type {
  Assembly,
  Clock,
  IdentityContext,
  IdempotencyContext,
  TxRunner,
} from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { StoreMembership } from "../tenant/index.js";
export interface PublishDeps {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  approval: Approval;
  flow: Flow;
  media: Pick<Media, "link" | "signRead">;
}
export interface PublishViewer {
  ctx: IdentityContext;
  membership: StoreMembership;
}
export interface PublishWriteOptions {
  idem?: IdempotencyContext;
}
