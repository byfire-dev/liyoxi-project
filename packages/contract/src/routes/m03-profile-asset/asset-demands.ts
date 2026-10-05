// 商家端：门店档案、资质与素材 · asset-demands（docs/api/m03-profile-asset.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mAssetDemandList = merchantMeta({
  method: "get",
  path: "/m/asset-demands",
  operationId: "m.assetDemand.list",
  summary: "素材需求（?status=open）：名称、拍摄说明、发起的服务经理、完成日期",
  "x-capability": "asset.demand.read",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
