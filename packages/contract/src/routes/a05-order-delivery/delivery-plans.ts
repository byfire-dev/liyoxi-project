// 后台：订购、取消、交付与广告任务 · delivery-plans（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";

export const adminDeliveryPlanGet = adminRoute({
  method: "get",
  path: "/admin/delivery-plans/{deliveryPlanId}",
  operationId: "admin.deliveryPlan.get",
  summary: "交付方案：当前草稿、已推送版本、商家修改请求",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: PlanParamSchema },
  responses: {
    ...okResponse(AdminDeliveryPlanDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryPlanDraftReplace = adminRoute({
  method: "put",
  path: "/admin/delivery-plans/{deliveryPlanId}/draft",
  operationId: "admin.deliveryPlan.draft.replace",
  summary:
    "保存方案草稿：植入形式与广告位、定制重点、发布账号、约定上线日、上线方式（带 draftLockVersion）",
  "x-permission": "delivery.plan.edit",
  "x-idempotent": "required",
  request: {
    params: PlanParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: PlanDraftReplaceBodySchema } },
    },
  },
  responses: {
    ...okResponse(AdminDeliveryPlanWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryPlanPush = adminRoute({
  method: "post",
  path: "/admin/delivery-plans/{deliveryPlanId}/push",
  operationId: "admin.deliveryPlan.push",
  summary: "推送方案给商家确认（生成方案版本；从已确认修订时须在变更窗口内）",
  "x-permission": "delivery.plan.push",
  "x-idempotent": "required",
  request: {
    params: PlanParamSchema,
    body: { required: true, content: { "application/json": { schema: PlanPushBodySchema } } },
  },
  responses: {
    ...okResponse(AdminDeliveryPlanWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

import { okResponse, errorResponses } from "../../common/index.js";
import {
  PlanParamSchema,
  PlanDraftReplaceBodySchema,
  PlanPushBodySchema,
  AdminDeliveryPlanDetailSchema,
  AdminDeliveryPlanWriteResultSchema,
} from "./delivery.schemas.js";
