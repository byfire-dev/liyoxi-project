// 商家端：交付与发布 · performance-reports（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPerformanceReportList = merchantMeta({
  method: "get",
  path: "/m/performance-reports",
  operationId: "m.performanceReport.list",
  summary: "V1.1：投放数据（概览、按周趋势、单集数据、月度效果报告）",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
