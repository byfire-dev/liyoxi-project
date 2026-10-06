// 后台：订购、取消、交付与广告任务 · delivery-tickets（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDeliveryTicketList = adminRoute({
  method: "get",
  path: "/admin/delivery-tickets",
  operationId: "admin.deliveryTicket.list",
  summary:
    "交付工单列表：状态页签、关键字、交付经理（含未分配）、制作模型、平台、仅看超时；默认按紧急程度排序；也用于各队列视图",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: TicketListQuerySchema },
  responses: {
    ...okResponse(DeliveryTicketPageSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketSummary = adminRoute({
  method: "get",
  path: "/admin/delivery-tickets/summary",
  operationId: "admin.deliveryTicket.summary",
  summary: "工单池页头统计与状态页签计数（处理中、超时或逾期、今日截止）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: TicketFilterSchema },
  responses: {
    ...okResponse(DeliveryTicketSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketGet = adminRoute({
  method: "get",
  path: "/admin/delivery-tickets/{deliveryTicketId}",
  operationId: "admin.deliveryTicket.get",
  summary:
    "工单详情聚合：11 步进度、方案、广告、样片与质检、成片与发布、侧栏商家 / 订购单 / 负责人 / 时效",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: TicketParamSchema },
  responses: {
    ...okResponse(DeliveryTicketDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketActivityList = adminMeta({
  method: "get",
  path: "/admin/delivery-tickets/{deliveryTicketId}/activities",
  operationId: "admin.deliveryTicket.activity.list",
  summary: "工单操作日志（系统、员工、商家）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDeliveryTicketAssignEditor = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/assign-editor",
  operationId: "admin.deliveryTicket.assignEditor",
  summary: "指派或改派剪辑师",
  "x-permission": "delivery.ticket.assign_editor",
  "x-idempotent": "required",
});

export const adminDeliveryTicketAssignManager = adminRoute({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/assign-manager",
  operationId: "admin.deliveryTicket.assignManager",
  summary: "分配交付经理（单选，显示在办量与轮询推荐，说明 ≤100 字）；进入方案确认并通知",
  "x-permission": "merchant.manager.assign",
  "x-idempotent": "required",
  request: {
    params: TicketParamSchema,
    body: { required: true, content: { "application/json": { schema: AssignManagerBodySchema } } },
  },
  responses: {
    ...okResponse(DeliveryTicketWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
  "x-redact-on-replay": ["currentSample.preview", "currentSample.decision.feedbackImages"],
});

export const adminDeliveryTicketAssignPublisher = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/assign-publisher",
  operationId: "admin.deliveryTicket.assignPublisher",
  summary: "改派发布专员（开工时已轮询指派）",
  "x-permission": "delivery.ticket.assign_publisher",
  "x-idempotent": "required",
});

export const adminDeliveryTicketEpisodeOutputList = adminRoute({
  method: "get",
  path: "/admin/delivery-tickets/{deliveryTicketId}/episode-outputs",
  operationId: "admin.deliveryTicket.episodeOutput.list",
  summary: "成片剧集列表：逐集文件、大小、质检状态（成片包格子）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: TicketParamSchema },
  responses: { ...okResponse(EpisodeGridSchema), ...errorResponses(400, 401, 403, 404, 409, 500) },
});

export const adminDeliveryTicketEpisodeOutputCreate = adminRoute({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/episode-outputs",
  operationId: "admin.deliveryTicket.episodeOutput.create",
  summary: "登记成片剧集（批量；同一集再登记即换版；可带补发单 id）",
  "x-permission": "delivery.episode.register",
  "x-idempotent": "required",
  request: {
    params: TicketParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: EpisodeRegisterBodySchema } },
    },
  },
  responses: {
    ...okResponse(EpisodeRegisterResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketForceTransition = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/force-transition",
  operationId: "admin.deliveryTicket.forceTransition",
  summary: "人工纠偏：把工单改到更正白名单内的指定步骤（写 is_forced 状态历史；原因不少于 10 字）",
  "x-permission": "flow.admin.transition",
  "x-idempotent": "required",
});

export const adminDeliveryTicketInspectEpisodes = adminRoute({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/inspect-episodes",
  operationId: "admin.deliveryTicket.inspectEpisodes",
  summary: "逐集质检（批量）：通过或不通过并注明原因；全部通过后系统推进到成片交付",
  "x-permission": "delivery.episode.qc",
  "x-idempotent": "required",
  request: {
    params: TicketParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: InspectEpisodesBodySchema } },
    },
  },
  responses: {
    ...okResponse(InspectEpisodesResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketInspectPackage = adminRoute({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/inspect-package",
  operationId: "admin.deliveryTicket.inspectPackage",
  summary: "成片包级质检（集数完整等成片阶段清单项）",
  "x-permission": "delivery.episode.qc",
  "x-idempotent": "required",
  request: {
    params: TicketParamSchema,
    body: { required: true, content: { "application/json": { schema: InspectPackageBodySchema } } },
  },
  responses: {
    ...okResponse(InspectPackageResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketMaterialList = adminMeta({
  method: "get",
  path: "/admin/delivery-tickets/{deliveryTicketId}/materials",
  operationId: "admin.deliveryTicket.material.list",
  summary: "制作素材清单（原片、门店素材、广告）：只列素材与上次取料记录，不签发地址",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDeliveryTicketMaterialDownloadUrls = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/materials/download-urls",
  operationId: "admin.deliveryTicket.material.downloadUrls",
  summary: "签发制作素材（原片、门店素材、广告）的短时下载地址，逐次留取料记录",
  "x-permission": "delivery.download",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录（A18）",
});

export const adminDeliveryTicketPushPackage = adminRoute({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/push-package",
  operationId: "admin.deliveryTicket.pushPackage",
  summary:
    "推送成片包与发布清单（交付前检查全过）：生成成片包与下载授权、为每个发布账号建上线任务、通知商家",
  "x-permission": "publish.package.push",
  "x-idempotent": "required",
  request: {
    params: TicketParamSchema,
    body: { required: true, content: { "application/json": { schema: PushPackageBodySchema } } },
  },
  responses: {
    ...okResponse(PushPackageResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminDeliveryTicketReevaluate = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/reevaluate",
  operationId: "admin.deliveryTicket.reevaluate",
  summary: "对卡住的工单重新求值（满足条件即推进步骤）",
  "x-permission": "flow.ops.manage",
  "x-idempotent": "required",
});

export const adminDeliveryTicketReissueCreate = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/reissues",
  operationId: "admin.deliveryTicket.reissue.create",
  summary: "发起补发（交付后发现成片有误；原因与说明必填）",
  "x-permission": "delivery.package.reissue",
  "x-idempotent": "required",
});

export const adminDeliveryTicketRemind = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/remind",
  operationId: "admin.deliveryTicket.remind",
  summary:
    "人工催办商家：确认方案、确认样片、上线提醒（订阅消息与短信补发；同一对象同一场景每日一次）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminDeliveryTicketRework = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/rework",
  operationId: "admin.deliveryTicket.rework",
  summary: "主管返工：从批量合成或成片交付退回样片制作（广告就绪）或广告准备，必填原因",
  "x-permission": "delivery.ticket.rework",
  "x-idempotent": "required",
});

export const adminDeliveryTicketSampleCreate = adminRoute({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/samples",
  operationId: "admin.deliveryTicket.sample.create",
  summary: "登记样片新版本（文件已上传；未决旧版本置 superseded）",
  "x-permission": "delivery.sample.upload",
  "x-idempotent": "required",
  request: {
    params: TicketParamSchema,
    body: { required: true, content: { "application/json": { schema: SampleCreateBodySchema } } },
  },
  responses: {
    ...okResponse(AdminSampleWriteResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
  "x-redact-on-replay": ["preview", "decision.feedbackImages"],
});

import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  TicketListQuerySchema,
  TicketFilterSchema,
  TicketParamSchema,
  AssignManagerBodySchema,
  DeliveryTicketPageSchema,
  DeliveryTicketSummarySchema,
  DeliveryTicketDetailSchema,
  DeliveryTicketWriteResultSchema,
} from "./delivery.schemas.js";

import {
  AdminSampleWriteResultSchema,
  EpisodeGridSchema,
  EpisodeRegisterBodySchema,
  EpisodeRegisterResultSchema,
  InspectEpisodesBodySchema,
  InspectEpisodesResultSchema,
  InspectPackageBodySchema,
  InspectPackageResultSchema,
  PushPackageBodySchema,
  PushPackageResultSchema,
  SampleCreateBodySchema,
} from "./production.schemas.js";
