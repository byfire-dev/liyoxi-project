// 后台：内容运营与通知配置 · agreement-versions（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";

export const adminAgreementVersionUpdate = adminRoute({
  method: "patch",
  path: "/admin/agreement-versions/{agreementVersionId}",
  operationId: "admin.agreementVersion.update",
  summary: "编辑草稿：生效时间、变更摘要、正文文件（Word 或 PDF）、是否需重新同意、法务审定勾选",
  "x-permission": null,
  "x-idempotent": "required",
  request: {
    params: AdminAgreementVersionParamsSchema,
    body: {
      content: { "application/json": { schema: AgreementVersionUpdateBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(AgreementVersionMutationResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminAgreementVersionSchedule = adminRoute({
  method: "post",
  path: "/admin/agreement-versions/{agreementVersionId}/schedule",
  operationId: "admin.agreementVersion.schedule",
  summary: "保存为待生效（文件齐全、法务审定、生效时间晚于 10 分钟后）；会员与积分协议同事务建公告",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    params: AdminAgreementVersionParamsSchema,
    body: {
      content: { "application/json": { schema: AgreementVersionScheduleBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(AgreementVersionScheduleResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminAgreementVersionWithdraw = adminRoute({
  method: "post",
  path: "/admin/agreement-versions/{agreementVersionId}/withdraw",
  operationId: "admin.agreementVersion.withdraw",
  summary: "撤回待生效版本（无同意记录且距生效 >10 分钟），内容复制为新草稿",
  "x-permission": null,
  "x-idempotent": "required",
  request: {
    params: AdminAgreementVersionParamsSchema,
    body: {
      content: { "application/json": { schema: AgreementVersionWithdrawBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(AgreementVersionWithdrawResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

import {
  AdminAgreementVersionParamsSchema,
  AgreementVersionMutationResultSchema,
  AgreementVersionScheduleBodySchema,
  AgreementVersionScheduleResultSchema,
  AgreementVersionUpdateBodySchema,
  AgreementVersionWithdrawBodySchema,
  AgreementVersionWithdrawResultSchema,
} from "./agreement.schemas.js";
