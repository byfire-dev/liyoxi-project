// 外部回调与探活 · wecom（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookMeta } from "../meta-only.js";

export const hooksWecomEventVerify = hookMeta({
  method: "get",
  path: "/hooks/wecom/events",
  operationId: "hooks.wecom.event.verify",
  summary: "企业微信回调地址校验：msg_signature 校验并解密 echostr 后返回",
  "x-idempotent-reason": "GET 地址校验，不写收件箱（C6；A18 纯查询）",
});

export const hooksWecomEventReceive = hookMeta({
  method: "post",
  path: "/hooks/wecom/events",
  operationId: "hooks.wecom.event.receive",
  summary: "企业微信客户联系事件（添加、半添加、删除外部联系人，被客户删除）：验签解密后落收件箱",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});
