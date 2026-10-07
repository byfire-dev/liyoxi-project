import { createIdentityContext, defineRegistration, isUuid } from "../kernel/index.js";
import { boundWebhooks } from "./webhooks/binding.js";

export const registration = defineRegistration("security", {
  subscribers: [
    {
      name: "security.onWebhookReceived",
      events: ["webhook.received"],
      handle: async (tx, event) => {
        const id = event.payload["webhookEventId"];
        if (typeof id !== "string" || !isUuid(id)) throw new TypeError("回调唤醒缺少可信收件ID");
        await boundWebhooks().process(
          tx,
          id,
          createIdentityContext({ actor: { type: "system", job: "security.webhook_received" } }),
        );
      },
    },
  ],
  cleanups: [
    {
      name: "security.webhook_payload",
      every: "day",
      run: (tx, input) => boundWebhooks().purge(tx, input),
    },
  ],
});
