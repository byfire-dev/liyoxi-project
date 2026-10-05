// 外部回调与探活 · wechat（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookMeta } from "../meta-only.js";

export const hooksWechatMessageVerify = hookMeta({
  method: "get",
  path: "/hooks/wechat/messages",
  operationId: "hooks.wechat.message.verify",
  summary: "小程序消息推送的服务器地址校验：校验 signature 后原样返回 echostr",
  "x-idempotent-reason": "GET 地址校验，不写收件箱（C6；A18 纯查询）",
});

export const hooksWechatMessageReceive = hookMeta({
  method: "post",
  path: "/hooks/wechat/messages",
  operationId: "hooks.wechat.message.receive",
  summary:
    "小程序消息推送：订阅消息事件（拒收、下发结果、弹窗）与内容安全异步结果；验签解密后落收件箱，5 秒内应答；客服消息被动回复转客服、不落库",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});
