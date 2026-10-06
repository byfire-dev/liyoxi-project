// 商家端：交付与发布 · channel-accounts（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mChannelAccountList = merchantRoute({
  method: "get",
  path: "/m/channel-accounts",
  operationId: "m.channelAccount.list",
  summary:
    "当前门店的渠道账号：平台、账号名称与 ID、状态（待核验/可用/异常）、认证类型、使用情况、异常原因与处理指引",
  "x-capability": "channel.manage",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: ChannelAccountListQuerySchema },
  responses: {
    ...okResponse(ChannelAccountPageSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mChannelAccountCreate = merchantRoute({
  method: "post",
  path: "/m/channel-accounts",
  operationId: "m.channelAccount.create",
  summary:
    "绑定渠道账号：{platform, accountName, accountId, accountType, screenshotFileIds}，生成账号核验单",
  "x-capability": "channel.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    body: {
      content: { "application/json": { schema: ChannelAccountCreateBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(ChannelAccountCardSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mChannelAccountSubmit = merchantRoute({
  method: "post",
  path: "/m/channel-accounts/{channelAccountId}/submit",
  operationId: "m.channelAccount.submit",
  summary: "核验未通过后重新上传主页截图（可重选账号类型；名称与账号 ID 不可改）",
  "x-capability": "channel.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: ChannelAccountParamSchema,
    body: {
      content: { "application/json": { schema: ChannelAccountSubmitBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(ChannelAccountCardSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mChannelAccountUnbind = merchantMeta({
  method: "post",
  path: "/m/channel-accounts/{channelAccountId}/unbind",
  operationId: "m.channelAccount.unbind",
  summary: "解绑渠道账号（无交付中、上线中订单项且无未核查的下架任务）",
  "x-capability": "channel.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  ChannelAccountCardSchema,
  ChannelAccountCreateBodySchema,
  ChannelAccountListQuerySchema,
  ChannelAccountPageSchema,
  ChannelAccountParamSchema,
  ChannelAccountSubmitBodySchema,
} from "./publish.schemas.js";
