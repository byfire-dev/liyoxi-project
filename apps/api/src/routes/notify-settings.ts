import { mNotifySettingList, NotifySettingListResultSchema } from "@liyoxi/contract";
import { ok } from "../http/errors.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { defineHandler } from "../routing/define.js";

export const notifySettingHandlers = [
  defineHandler(mNotifySettingList, async (c) => {
    const { merchantUserId, sessionId, wechatIdentityId } = merchantSessionOf(c);
    const result = await c.var.runtime.notifyMessages.settings({
      merchantUserId,
      sessionId,
      wechatIdentityId,
      storeId: c.req.header("X-Store-Id") ?? null,
    });
    c.header("Cache-Control", "no-store");
    return ok(c, NotifySettingListResultSchema.parse(result));
  }),
];
