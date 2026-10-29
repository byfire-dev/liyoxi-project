import type { StaffBrief } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
import type { MediaActor } from "./actor.js";

export type ProductionPermission =
  "production.normalize" | "production.restamp" | "production.recheck";
/** Parent owners supply scope and display facts; this leaf has no media runtime dependencies. */
export interface ProductionAccess {
  readonly require: (
    tx: Tx,
    actor: MediaActor,
    parent: { orderItemId: string | null; adId: string | null },
    permission?: ProductionPermission,
  ) => Promise<void>;
  readonly master: (tx: Tx, id: string) => Promise<{ id: string; revNo: number } | null>;
  readonly staff: (tx: Tx, id: string) => Promise<StaffBrief | null>;
}
