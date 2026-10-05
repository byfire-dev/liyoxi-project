// 后台：工作台、报表与导出 · export-jobs（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminExportJobList = adminMeta({
  method: "get",
  path: "/admin/export-jobs",
  operationId: "admin.exportJob.list",
  summary: "我的导出记录（页头“导出记录”抽屉）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminExportJobCreate = adminMeta({
  method: "post",
  path: "/admin/export-jobs",
  operationId: "admin.exportJob.create",
  summary: "申请导出（按当前筛选条件，异步生成 CSV 或 XLSX；同参数进行中任务返回同一个）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_export_job_inflight"],
});

export const adminExportJobGet = adminMeta({
  method: "get",
  path: "/admin/export-jobs/{exportJobId}",
  operationId: "admin.exportJob.get",
  summary: "导出任务状态（前端每 2 秒轮询，至多 2 分钟）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminExportJobCancel = adminMeta({
  method: "post",
  path: "/admin/export-jobs/{exportJobId}/cancel",
  operationId: "admin.exportJob.cancel",
  summary: "取消排队中的导出任务",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminExportJobDownloadUrls = adminMeta({
  method: "post",
  path: "/admin/export-jobs/{exportJobId}/download-urls",
  operationId: "admin.exportJob.downloadUrls",
  summary:
    "签发 5 分钟下载地址（申请人本人；复核仍有该导出权限，不通过则置过期并返回 status = revoked；记下载审计）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录（A18）",
});
