import type { Config } from "../config/index.js";
import type { Flow } from "../flow/index.js";
import type { Clock, TxRunner, StaffWorkSources, StaffActivationSender } from "../kernel/index.js";
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
  sendWecomInvite?: (input: { staffId: string; createdAt: Date }) => Promise<{ created: boolean }>;
  sendActivation?: StaffActivationSender;
  media?: Pick<Media, "link" | "release" | "signRead">;
  events?: Pick<Events, "emit">;
  sla?: Pick<Sla, "dueAt">;
  timers?: Pick<Timers, "arm" | "cancel">;
}
