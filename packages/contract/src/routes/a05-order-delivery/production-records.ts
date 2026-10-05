// 后台：订购、取消、交付与广告任务 · production-records（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminProductionRecordList = adminMeta({
  method: "get",
  path: "/admin/production-records",
  operationId: "admin.productionRecord.list",
  summary: "制作文件事实查询（体检结论、AI 声明、隐式标识回读）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminProductionRecordNormalize = adminMeta({
  method: "post",
  path: "/admin/production-records/{productionRecordId}/normalize",
  operationId: "admin.productionRecord.normalize",
  summary: "云端规格化（人工触发，产出新文件）",
  "x-permission": "production.normalize",
  "x-idempotent": "required",
});

export const adminProductionRecordRecheck = adminMeta({
  method: "post",
  path: "/admin/production-records/{productionRecordId}/recheck",
  operationId: "admin.productionRecord.recheck",
  summary: "规则版本升级后人工触发重检",
  "x-permission": "production.recheck",
  "x-idempotent": "required",
});

export const adminProductionRecordRestamp = adminMeta({
  method: "post",
  path: "/admin/production-records/{productionRecordId}/restamp",
  operationId: "admin.productionRecord.restamp",
  summary: "补标：更正 AI 声明后写入隐式标识（产生新文件）",
  "x-permission": "production.restamp",
  "x-idempotent": "required",
});
