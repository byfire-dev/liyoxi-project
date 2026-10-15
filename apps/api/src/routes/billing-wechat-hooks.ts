import { hooksWechatpayTransactionNotify } from "@liyoxi/contract";
import { receiveWebhook } from "../http/webhook.js";
import { defineHandler } from "../routing/define.js";
export const billingWechatHookHandlers = [
  defineHandler(hooksWechatpayTransactionNotify, async (c) => {
    const response = await receiveWebhook(c);
    if (response.status === 200) {
      // 原始字节已由框架验签；这里只取通知身份寻找已提交收件事实，不信任明文付款结果。
      const body: unknown = await c.req.json().catch(() => null);
      if (body && typeof body === "object" && "id" in body && typeof body.id === "string")
        await c.var.runtime.billing.wechatChannel.inlineWebhook(body.id);
    }
    return response;
  }),
];
