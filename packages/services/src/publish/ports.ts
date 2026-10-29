import { definePort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
export interface LaunchChanged {
  orderItemId: string;
  deliveryTicketId: string;
  /** Prepares the same transaction before publishing takes any business locks. */
  phase?: "prelock";
  approvalRequestId?: string;
  staffId?: string;
  fileIds?: readonly string[];
}
// W1-16a 同事务求值 12–14 行，再转交 orderSidePort；M1 不回写同层表。
export const launchChangedPort = definePort<(tx: Tx, input: LaunchChanged) => Promise<void>>(
  "publish.launch_changed",
  { fallback: async () => {} },
);
export const launchHandlerPort = definePort<
  (tx: Tx, deliveryTicketId: string) => Promise<string | null>
>("publish.launch_handler", { fallback: async () => null });
