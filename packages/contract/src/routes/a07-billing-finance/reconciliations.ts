// 后台：套餐积分与财务 · reconciliations（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  ReconciliationMonthQuerySchema,
  ReconciliationParamsSchema,
  ReconciliationRerunBodySchema,
  ReconDayRowSchema,
  ReconMonthSchema,
} from "./reconciliations.schemas.js";

export const adminReconciliationList = adminRoute({
  request: { query: ReconciliationMonthQuerySchema },
  responses: { ...okResponse(ReconMonthSchema), ...errorResponses(400, 401, 403, 503) },
  method: "get",
  path: "/admin/reconciliations",
  operationId: "admin.reconciliation.list",
  summary:
    "按月查看对账：月度概览、每日对账行（平台收款、微信账单、对公、退款、差异、状态）、账单下载进度",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReconciliationRerun = adminRoute({
  request: {
    params: ReconciliationParamsSchema,
    body: {
      content: { "application/json": { schema: ReconciliationRerunBodySchema } },
      required: true,
    },
  },
  responses: { ...okResponse(ReconDayRowSchema), ...errorResponses(400, 401, 403, 404, 409, 503) },
  method: "post",
  path: "/admin/reconciliations/{reconciliationId}/rerun",
  operationId: "admin.reconciliation.rerun",
  summary: "重新对账（重跑某日匹配步骤）",
  "x-permission": "finance.recon.resolve",
  "x-idempotent": "required",
  "x-three-phase": true,
  "x-idempotent-reason":
    "C51多事务：按商户号和账单日持会话锁串行，逐主体补记后同末TX保存日汇总与幂等响应",
});
