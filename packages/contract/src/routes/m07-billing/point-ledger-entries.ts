// 商家端：套餐、积分、付款与发票 · point-ledger-entries（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPointLedgerEntryList = merchantMeta({
  method: "get",
  path: "/m/point-ledger-entries",
  operationId: "m.pointLedgerEntry.list",
  summary:
    "积分明细（?tab=all|gain|use|expire&month=YYYY-MM，默认当月，逐月加载）：标题、积分来源、时间、门店与关联单号、计算式备注、数量；响应带 prevMonth 与 firstEntryAt",
  "x-capability": "ledger.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
