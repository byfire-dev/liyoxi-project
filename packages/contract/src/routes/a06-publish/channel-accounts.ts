// 后台：发布与巡检 · channel-accounts（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminChannelAccountList = adminMeta({
  method: "get",
  path: "/admin/channel-accounts",
  operationId: "admin.channelAccount.list",
  summary:
    "渠道账号列表（商家详情“渠道账号”页签）：平台、账号名、账号 ID、状态、类型、认证主体、核验记录、使用中的剧目",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminChannelAccountSummary = adminMeta({
  method: "get",
  path: "/admin/channel-accounts/summary",
  operationId: "admin.channelAccount.summary",
  summary: "渠道账号计数（商家详情“渠道账号”页签角标，按状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminChannelAccountGet = adminRoute({
  method: "get",
  path: "/admin/channel-accounts/{channelAccountId}",
  operationId: "admin.channelAccount.get",
  summary: "渠道账号详情与历次核验提交",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: ChannelAccountParamSchema },
  responses: {
    ...okResponse(ChannelAccountDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminChannelAccountMarkAbnormal = adminMeta({
  method: "post",
  path: "/admin/channel-accounts/{channelAccountId}/mark-abnormal",
  operationId: "admin.channelAccount.markAbnormal",
  summary: "把可用账号人工标记为异常（原因与说明必填）；新订购与新方案不可选，不影响在办订单",
  "x-permission": "publish.account.mark_abnormal",
  "x-idempotent": "required",
});

import { ChannelAccountParamSchema } from "../m05-delivery-publish/publish.schemas.js";

import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { ChannelAccountDetailSchema } from "./publish.schemas.js";
