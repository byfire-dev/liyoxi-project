// 后台：发布与巡检 · metric-imports（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminMetricImportCreate = adminMeta({
  method: "post",
  path: "/admin/metric-imports",
  operationId: "admin.metricImport.create",
  summary: "上传 Excel 并逐行校验（返回逐行结果与导入批次）",
  "x-permission": "publish.metrics.enter",
  "x-idempotent": "required",
});

export const adminMetricImportTemplateGet = adminMeta({
  method: "get",
  path: "/admin/metric-imports/template",
  operationId: "admin.metricImport.template.get",
  summary: "下载数据录入模板",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminMetricImportCommit = adminMeta({
  method: "post",
  path: "/admin/metric-imports/{metricImportId}/commit",
  operationId: "admin.metricImport.commit",
  summary: "提交导入：只导入校验通过的行（按批次防重复）",
  "x-permission": "publish.metrics.enter",
  "x-idempotent": "required",
});
