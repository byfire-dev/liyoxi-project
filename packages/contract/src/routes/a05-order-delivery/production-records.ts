// 后台：订购、取消、交付与广告任务 · production-records（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  ProductionRecordParamSchema,
  ProductionRecordQuerySchema,
  ProductionRecordPageSchema,
  ProductionJobAcceptedSchema,
  NormalizeBodySchema,
  RestampBodySchema,
  RecheckBodySchema,
} from "./production.schemas.js";

export const adminProductionRecordList = adminRoute({
  method: "get",
  path: "/admin/production-records",
  operationId: "admin.productionRecord.list",
  summary: "制作文件事实查询（体检结论、AI 声明、隐式标识回读）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: ProductionRecordQuerySchema },
  responses: {
    ...okResponse(ProductionRecordPageSchema),
    ...errorResponses(400, 401, 403, 500, 503),
  },
});

export const adminProductionRecordNormalize = adminRoute({
  method: "post",
  path: "/admin/production-records/{productionRecordId}/normalize",
  operationId: "admin.productionRecord.normalize",
  summary: "云端规格化（人工触发，产出新文件）",
  "x-permission": "production.normalize",
  "x-idempotent": "required",
  request: {
    params: ProductionRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: NormalizeBodySchema } } },
  },
  responses: {
    ...okResponse(ProductionJobAcceptedSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500, 503),
  },
});

export const adminProductionRecordRecheck = adminRoute({
  method: "post",
  path: "/admin/production-records/{productionRecordId}/recheck",
  operationId: "admin.productionRecord.recheck",
  summary: "规则版本升级后人工触发重检",
  "x-permission": "production.recheck",
  "x-idempotent": "required",
  request: {
    params: ProductionRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: RecheckBodySchema } } },
  },
  responses: {
    ...okResponse(ProductionJobAcceptedSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500, 503),
  },
});

export const adminProductionRecordRestamp = adminRoute({
  method: "post",
  path: "/admin/production-records/{productionRecordId}/restamp",
  operationId: "admin.productionRecord.restamp",
  summary: "补标：更正 AI 声明后写入隐式标识（产生新文件）",
  "x-permission": "production.restamp",
  "x-idempotent": "required",
  request: {
    params: ProductionRecordParamSchema,
    body: { required: true, content: { "application/json": { schema: RestampBodySchema } } },
  },
  responses: {
    ...okResponse(ProductionJobAcceptedSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500, 503),
  },
});
