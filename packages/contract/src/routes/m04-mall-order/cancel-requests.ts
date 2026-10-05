// 商家端：商城、选剧单与订购 · cancel-requests（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mCancelRequestCreate = merchantMeta({
  method: "post",
  path: "/m/cancel-requests",
  operationId: "m.cancelRequest.create",
  summary: "V1.1：商家自助申请取消订购或广告（退款申请）",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
