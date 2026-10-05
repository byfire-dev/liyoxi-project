// 商家端：门店档案、资质与素材 · qualification-submissions（docs/api/m03-profile-asset.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mQualificationSubmissionList = merchantMeta({
  method: "get",
  path: "/m/qualification-submissions",
  operationId: "m.qualificationSubmission.list",
  summary: "历次审核记录：提交、驳回（原因分类、说明、被驳回证照）、重新提交、通过的时间线",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
