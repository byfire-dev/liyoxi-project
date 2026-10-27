import { hooksWechatpayRefundNotify } from "@liyoxi/contract";
import { receiveWebhook } from "../http/webhook.js";
import { defineHandler } from "../routing/define.js";
export const billingRefundHookHandlers = [
  defineHandler(hooksWechatpayRefundNotify, receiveWebhook),
];
