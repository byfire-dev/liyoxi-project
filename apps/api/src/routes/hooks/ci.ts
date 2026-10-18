import { hooksCiMediaJobWake } from "@liyoxi/contract";
import { receiveWebhook } from "../../http/webhook.js";
import { defineHandler } from "../../routing/define.js";
// 计数与运行时共用正式回调身份；契约误绑到另一入口时在装配阶段拒绝。
if (hooksCiMediaJobWake.operationId !== "hooks.ci.mediaJob.wake")
  throw new TypeError("CI 媒体回调契约登记不一致");
export const ciHookHandlers = [
  defineHandler(hooksCiMediaJobWake, async (c) => {
    const response = await receiveWebhook(c);
    if (response.status === 200)
      await c.var.runtime.media.jobs.wake(c.req.valid("param").mediaJobId);
    return response;
  }),
];
