// 后台：内容运营与通知配置 · agreements（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";

export const adminAgreementList = adminRoute({
  method: "get",
  path: "/admin/agreements",
  operationId: "admin.agreement.list",
  summary:
    "协议清单（V1.0 6 份；服务商合作协议 partner 由 M9 推到 V1.1）：当前版本、待生效、草稿角标",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: AdminAgreementListQuerySchema },
  responses: {
    ...okResponse(AdminAgreementListSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminAgreementGet = adminRoute({
  method: "get",
  path: "/admin/agreements/{agreementKey}",
  operationId: "admin.agreement.get",
  summary: "协议详情：版本记录、正文、重新同意进度（已同意 / 应同意）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: AgreementKeyParamsSchema },
  responses: {
    ...okResponse(AgreementDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

export const adminAgreementAgreementVersionCreate = adminRoute({
  method: "post",
  path: "/admin/agreements/{agreementKey}/agreement-versions",
  operationId: "admin.agreement.agreementVersion.create",
  summary: "新建协议版本草稿（版本号自动递增）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
  request: {
    params: AgreementKeyParamsSchema,
    body: {
      content: { "application/json": { schema: AgreementVersionCreateBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(AgreementVersionMutationResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 503),
  },
});

import {
  AdminAgreementListQuerySchema,
  AdminAgreementListSchema,
  AgreementDetailSchema,
  AgreementKeyParamsSchema,
  AgreementVersionCreateBodySchema,
  AgreementVersionMutationResultSchema,
} from "./agreement.schemas.js";
export * from "./agreement.schemas.js";
