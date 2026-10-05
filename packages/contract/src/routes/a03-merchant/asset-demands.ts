// 后台：商家、资质审核与素材复核 · asset-demands（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAssetDemandList = adminMeta({
  method: "get",
  path: "/admin/asset-demands",
  operationId: "admin.assetDemand.list",
  summary: "素材需求列表（门店素材页签上方）：标题、说明、发起人、完成时间、已收到条数、状态",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAssetDemandCreate = adminMeta({
  method: "post",
  path: "/admin/asset-demands",
  operationId: "admin.assetDemand.create",
  summary: "发起素材需求（名称、拍摄说明、完成日期、通知对象），通知老板与店员",
  "x-permission": "merchant.asset.demand.create",
  "x-idempotent": "required",
});

export const adminAssetDemandCancel = adminMeta({
  method: "post",
  path: "/admin/asset-demands/{assetDemandId}/cancel",
  operationId: "admin.assetDemand.cancel",
  summary: "撤销素材需求",
  "x-permission": "merchant.asset.demand.create",
  "x-idempotent": "required",
});

export const adminAssetDemandComplete = adminMeta({
  method: "post",
  path: "/admin/asset-demands/{assetDemandId}/complete",
  operationId: "admin.assetDemand.complete",
  summary: "标记素材需求完成",
  "x-permission": "merchant.asset.demand.create",
  "x-idempotent": "required",
});
