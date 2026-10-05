// 商家端：客服、消息与通用接口 · faqs（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mFaqList = merchantMeta({
  method: "get",
  path: "/m/faqs",
  operationId: "m.faq.list",
  summary: "V1.1：常见问题（按分类）",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
