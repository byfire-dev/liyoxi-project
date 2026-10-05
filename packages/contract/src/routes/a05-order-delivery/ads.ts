// 后台：订购、取消、交付与广告任务 · ads（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAdList = adminMeta({
  method: "get",
  path: "/admin/ads",
  operationId: "admin.ad.list",
  summary: "广告制作任务队列：待处理（待指派、制作中、修改中）、待商家确认、已确认；紧急的排前",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAdSummary = adminMeta({
  method: "get",
  path: "/admin/ads/summary",
  operationId: "admin.ad.summary",
  summary: "广告制作任务页签计数：待处理（待指派、制作中、修改中）、待商家确认、已确认",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAdGet = adminMeta({
  method: "get",
  path: "/admin/ads/{adId}",
  operationId: "admin.ad.get",
  summary: "广告任务详情：需求、关联工单、积分、修改次数、版本与修改记录、预览",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAdAdVersionCreate = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/ad-versions",
  operationId: "admin.ad.adVersion.create",
  summary:
    "登记第 N 版（文件已上传，竖屏 9:16、1080×1920、标注“广告”）；上传后未推送的旧版本置 superseded",
  "x-permission": "delivery.ad.upload",
  "x-idempotent": "required",
});

export const adminAdAssign = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/assign",
  operationId: "admin.ad.assign",
  summary: "指派剪辑师（默认推荐在办最少者），开始制作并由冻结转扣减积分",
  "x-permission": "delivery.ad.assign",
  "x-idempotent": "required",
});

export const adminAdCancelQuote = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/cancel-quote",
  operationId: "admin.ad.cancelQuote",
  summary: "广告取消预览（退回积分与账本去向）",
  "x-permission": "order.refund.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminAdCancelRequestCreate = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/cancel-requests",
  operationId: "admin.ad.cancelRequest.create",
  summary: "发起广告取消（kind = ad_cancel）",
  "x-permission": "order.refund.request",
  "x-idempotent": "required",
});

export const adminAdRemind = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/remind",
  operationId: "admin.ad.remind",
  summary: "催办商家确认广告（限频）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminAdRequestChange = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/request-change",
  operationId: "admin.ad.requestChange",
  summary: "交付经理代录广告修改意见（仅免费次数内）",
  "x-permission": "delivery.sample.feedback_on_behalf",
  "x-idempotent": "required",
});

export const adminAdReturn = adminMeta({
  method: "post",
  path: "/admin/ads/{adId}/return",
  operationId: "admin.ad.return",
  summary: "退回补充素材（必填原因）",
  "x-permission": "delivery.ad.return",
  "x-idempotent": "required",
});
