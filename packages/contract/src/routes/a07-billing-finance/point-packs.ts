// 后台：套餐积分与财务 · point-packs（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPointPackList = adminMeta({
  method: "get",
  path: "/admin/point-packs",
  operationId: "admin.pointPack.list",
  summary: "积分包列表（积分、价格、单价、本月售出、状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointPackCreate = adminMeta({
  method: "post",
  path: "/admin/point-packs",
  operationId: "admin.pointPack.create",
  summary: "新增积分包（新增即上架；积分 ≥100、上架中不重复）",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
});

export const adminPointPackSummary = adminMeta({
  method: "get",
  path: "/admin/point-packs/summary",
  operationId: "admin.pointPack.summary",
  summary: "积分包页 KPI 与近 6 个月加购积分柱状图数据",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointPackUpdate = adminMeta({
  method: "patch",
  path: "/admin/point-packs/{pointPackId}",
  operationId: "admin.pointPack.update",
  summary: "编辑积分包（之后的购买生效；未支付付款单按原价）",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
});

export const adminPointPackDelist = adminMeta({
  method: "post",
  path: "/admin/point-packs/{pointPackId}/delist",
  operationId: "admin.pointPack.delist",
  summary: "下架积分包",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
});

export const adminPointPackShelve = adminMeta({
  method: "post",
  path: "/admin/point-packs/{pointPackId}/shelve",
  operationId: "admin.pointPack.shelve",
  summary: "上架积分包",
  "x-permission": "billing.pack.edit",
  "x-idempotent": "required",
});
