// 外部回调与探活 · wechat（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookRoute } from "../builders.js";
import { z } from "../../zod.js";
import {
  WechatVerifyQuerySchema,
  WechatMessageQuerySchema,
  WechatEncryptedMessageSchema,
  WechatEncryptedReplySchema,
} from "./wechat.schemas.js";

const failure = { description: "微信协议失败；不返回通用错误信封" };
const failures = {
  400: failure,
  401: failure,
  404: failure,
  413: failure,
  429: failure,
  500: failure,
};

export const hooksWechatMessageVerify = hookRoute({
  method: "get",
  path: "/hooks/wechat/messages",
  operationId: "hooks.wechat.message.verify",
  summary: "小程序消息推送的服务器地址校验：校验 signature 后原样返回 echostr",
  "x-idempotent-reason": "GET 地址校验，不写收件箱（C6；A18 纯查询）",
  request: { query: WechatVerifyQuerySchema },
  responses: {
    200: { description: "原样返回 echostr", content: { "text/plain": { schema: z.string() } } },
    ...failures,
  },
});

export const hooksWechatMessageReceive = hookRoute({
  method: "post",
  path: "/hooks/wechat/messages",
  operationId: "hooks.wechat.message.receive",
  summary:
    "小程序消息推送：订阅消息事件（拒收、下发结果、弹窗）与内容安全异步结果；验签解密后落收件箱，5 秒内应答；客服消息被动回复转客服、不落库",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
  request: {
    query: WechatMessageQuerySchema,
    body: {
      required: true,
      content: { "application/json": { schema: WechatEncryptedMessageSchema } },
    },
  },
  responses: {
    200: {
      description: "success，或安全模式下加密的客服转接回复",
      content: {
        "text/plain": { schema: z.literal("success") },
        "application/json": { schema: WechatEncryptedReplySchema },
      },
    },
    ...failures,
  },
});
