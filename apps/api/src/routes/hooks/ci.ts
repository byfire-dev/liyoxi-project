import { hooksCiMediaJobWake } from "@liyoxi/contract";
import { receiveWebhook } from "../../http/webhook.js";
import { defineHandler } from "../../routing/define.js";
export const ciHookHandlers = [
  defineHandler(hooksCiMediaJobWake, async (c) => {
    const response = await receiveWebhook(c);
    if (response.status === 200)
      await c.var.runtime.media.jobs.wake(c.req.valid("param").mediaJobId);
    return response;
  }),
];
