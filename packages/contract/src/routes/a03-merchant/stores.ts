// 后台：商家、资质审核与素材复核 · stores（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { StoreActivityPageSchema, StoreActivityQuerySchema } from "./store-activity.schemas.js";
import { AdminStoreProfileSchema, ProxyEditBodySchema } from "./store-profile.schemas.js";
import { AdminStoreQualificationViewSchema } from "./store-qualification.schemas.js";
import {
  ManagerAssignResultSchema,
  StoreHeaderSchema,
  AdminStoreListSchema,
  ManagerAssignBodySchema,
  StoreIdParamsSchema,
  StoreListQuerySchema,
  StoreListSummaryQuerySchema,
  StoreListSummarySchema,
} from "./stores.schemas.js";

export const adminStoreList = adminRoute({
  method: "get",
  path: "/admin/stores",
  operationId: "admin.store.list",
  summary:
    "商家（门店）列表：关键字、区域、行业、审核状态、来源、交付经理、套餐版本、到期；排序与分页；也用于门店远程搜索下拉",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: StoreListQuerySchema },
  responses: { ...okResponse(AdminStoreListSchema), ...errorResponses(400, 401, 403, 404, 409) },
});

export const adminStoreSummary = adminRoute({
  method: "get",
  path: "/admin/stores/summary",
  operationId: "admin.store.summary",
  summary: "商家列表页头统计：共 N 家、付费、套餐生效、审核中、本月新增",
  "x-permission": null,
  request: { query: StoreListSummaryQuerySchema },
  responses: { ...okResponse(StoreListSummarySchema), ...errorResponses(400, 401, 403, 409) },
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminStoreGet = adminRoute({
  method: "get",
  path: "/admin/stores/{storeId}",
  operationId: "admin.store.get",
  summary: "商家详情页头：门店、主体、标签、联系人（脱敏）、交付经理、5 张 KPI 卡",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: StoreIdParamsSchema },
  responses: { ...okResponse(StoreHeaderSchema), ...errorResponses(400, 401, 403, 404, 409) },
});

export const adminStoreActivityList = adminRoute({
  method: "get",
  path: "/admin/stores/{storeId}/activities",
  operationId: "admin.store.activity.list",
  summary: "门店活动流（操作日志页签）：商家、店员、系统、员工的操作与变更",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: StoreIdParamsSchema, query: StoreActivityQuerySchema },
  responses: { ...okResponse(StoreActivityPageSchema), ...errorResponses(400, 401, 403, 404) },
});

export const adminStoreProfileGet = adminRoute({
  method: "get",
  path: "/admin/stores/{storeId}/profile",
  operationId: "admin.store.profile.get",
  summary: "档案页签：基本信息、主推服务、门店图片、完整度、最近修改人",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: StoreIdParamsSchema },
  responses: { ...okResponse(AdminStoreProfileSchema), ...errorResponses(400, 401, 403, 404) },
});

export const adminStoreProfileUpdate = adminRoute({
  method: "patch",
  path: "/admin/stores/{storeId}/profile",
  operationId: "admin.store.profile.update",
  summary: "代改档案（免审字段；必选修改原因 + 备注；带 lockVersion；通知商家，修改前后记入日志）",
  "x-permission": "merchant.profile.proxy_edit",
  "x-idempotent": "required",
  "x-three-phase": true,
  request: {
    params: StoreIdParamsSchema,
    body: { required: true, content: { "application/json": { schema: ProxyEditBodySchema } } },
  },
  responses: {
    ...okResponse(AdminStoreProfileSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const adminStoreQualificationGet = adminRoute({
  method: "get",
  path: "/admin/stores/{storeId}/qualification",
  operationId: "admin.store.qualification.get",
  summary: "资质页签：结论摘要、生效证照与识别字段（脱敏）、历次审核记录",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: StoreIdParamsSchema },
  responses: {
    ...okResponse(AdminStoreQualificationViewSchema),
    ...errorResponses(400, 401, 403, 404),
  },
});

export const adminStoreAssignDeliveryManager = adminRoute({
  method: "post",
  path: "/admin/stores/{storeId}/assign-delivery-manager",
  operationId: "admin.store.assignDeliveryManager",
  summary:
    "首次指派交付经理（门店还没有交付经理时）：写门店交付经理，同步未结订购单，同事务分配本门店的待分配工单",
  "x-permission": "merchant.manager.assign",
  "x-idempotent": "required",
  request: {
    params: StoreIdParamsSchema,
    body: { content: { "application/json": { schema: ManagerAssignBodySchema } }, required: true },
  },
  responses: {
    ...okResponse(ManagerAssignResultSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

export const adminStoreReassignDeliveryManager = adminMeta({
  method: "post",
  path: "/admin/stores/{storeId}/reassign-delivery-manager",
  operationId: "admin.store.reassignDeliveryManager",
  summary:
    "转移交付经理：门店与在办工单、订购单、客服工单一并移交（已归档的不动），通知商家，新经理 1 个工作日内联系",
  "x-permission": "merchant.manager.transfer",
  "x-idempotent": "required",
});
