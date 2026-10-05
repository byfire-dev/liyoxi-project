// 后台：工作台、报表与导出 · reports（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminReportAdsGet = adminMeta({
  method: "get",
  path: "/admin/reports/ads",
  operationId: "admin.report.ads.get",
  summary: "广告制作（新广告、消耗积分、修改次数、首版按时率、复用率、按剪辑师）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportDeliveryGet = adminMeta({
  method: "get",
  path: "/admin/reports/delivery",
  operationId: "admin.report.delivery.get",
  summary: "交付效率（交付时长中位数、按时上线率、样片一次通过率、环节用时、按交付经理）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportDramasGet = adminMeta({
  method: "get",
  path: "/admin/reports/dramas",
  operationId: "admin.report.dramas.get",
  summary: "短剧销售排行（订购次数、消耗积分、订购商家；热度等级分布；授权期提醒）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportOverviewGet = adminMeta({
  method: "get",
  path: "/admin/reports/overview",
  operationId: "admin.report.overview.get",
  summary:
    "经营概览：MRR、收款额、付费主体、新开通与续费、续费率、积分消耗、订购部数；每日收款、近 6 月 MRR、收款构成、付费主体分布",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportPartnersGet = adminMeta({
  method: "get",
  path: "/admin/reports/partners",
  operationId: "admin.report.partners.get",
  summary: "服务商业绩（名下商家、名下实付、返佣）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportPointsGet = adminMeta({
  method: "get",
  path: "/admin/reports/points",
  operationId: "admin.report.points.get",
  summary: "积分报表：积分负债与折合预收款、发放、加购、消耗、清零、退回；流转、近 6 月、按来源",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminReportServiceGet = adminMeta({
  method: "get",
  path: "/admin/reports/service",
  operationId: "admin.report.service.get",
  summary: "客服报表（工单量、首次响应、方案按时率、解决率、满意度、按客服）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
