import type { Config } from "../config/index.js";
import type { Flow } from "../flow/index.js";
import type {
  Clock,
  Tx,
  TxRunner,
  StaffWorkSources,
  StaffActivationSender,
} from "../kernel/index.js";
import type { Keyring } from "../security/index.js";
import type { Media } from "../media/index.js";
import type { Events } from "../events/index.js";
import type { Sla } from "../sla/index.js";
import type { Timers } from "../timers/index.js";

export interface StaffManagementDeps {
  tx: TxRunner;
  clock: Clock;
  flow: Pick<Flow, "transition">;
  config: Pick<Config, "flags" | "dicts">;
  keyring: () => Keyring;
  workSources?: StaffWorkSources;
  /** 订单拥有者公口；单店转移只补空负责人，计划集合须进入transferWork原锁图。 */
  storeManagerOrders?: {
    readUnassignedIds(
      tx: Tx,
      scope: { entityId: string; storeId: string },
    ): Promise<readonly string[]>;
    syncUnassigned(
      tx: Tx,
      input: {
        entityId: string;
        storeId: string;
        ids: readonly string[];
        staffId: string;
        now: Date;
      },
    ): Promise<number>;
  };
  sendWecomInvite?: (input: { staffId: string; createdAt: Date }) => Promise<{ created: boolean }>;
  sendActivation?: StaffActivationSender;
  media?: Pick<Media, "link" | "release" | "signRead">;
  events?: Pick<Events, "emit">;
  sla?: Pick<Sla, "dueAt">;
  timers?: Pick<Timers, "arm" | "cancel">;
}
