import type { DomainLoopDef } from "../loop.js";
export const webhookReprocess: DomainLoopDef = {
  name: "webhook_reprocess",
  intervalMs: 60_000,
  run: (services, beat) => services.reprocessWebhooks(beat),
};
