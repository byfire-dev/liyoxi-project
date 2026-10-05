// 商家端：套餐、积分、付款与发票 · point-packs（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPointPackList = merchantMeta({
  method: "get",
  path: "/m/point-packs",
  operationId: "m.pointPack.list",
  summary: "上架中的加购积分包（积分数、价格）",
  "x-capability": "points.topup",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
