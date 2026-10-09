import { allRoutes, hooksWechatMessageVerify } from "@liyoxi/contract";
import { receiveWebhook } from "../../http/webhook.js";
import { defineHandler } from "../../routing/define.js";

const receiveRoute = allRoutes.find(
  (route) => route.operationId === "hooks.wechat.message.receive",
);
if (!receiveRoute) throw new TypeError("微信消息接收契约缺失");

export const wechatHookHandlers = [
  defineHandler(hooksWechatMessageVerify, receiveWebhook),
  defineHandler(receiveRoute, receiveWebhook),
];
