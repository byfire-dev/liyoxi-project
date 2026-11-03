import type { Events } from "../events/index.js";
import type { Sla } from "../sla/index.js";
import type { Timers } from "../timers/index.js";
import type { PublishDeps } from "./context.js";
export interface TakedownDeps extends PublishDeps {
  events: Events;
  timers: Pick<Timers, "arm" | "cancel">;
  sla: Sla;
  /** Deterministic isolated-test seam; production draws uniformly from 1–10000. */
  sampleDraw?: () => number;
}
