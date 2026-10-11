import { hooksAsrMediaJobWake } from "@liyoxi/contract";
import { receiveWebhook } from "../../http/webhook.js";
import { defineHandler } from "../../routing/define.js";

export const asrHookHandlers = [
  defineHandler(hooksAsrMediaJobWake, async (c) => {
    const response = await receiveWebhook(c);
    // Receipt commits before signaling; duplicate/ignored receipts may harmlessly wake the old queue.
    if (response.status === 200)
      await c.var.runtime.media.jobs.wake(c.req.valid("param").mediaJobId);
    return response;
  }),
];
