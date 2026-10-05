// 商家端：客服、消息与通用接口 · me（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mMeOverviewGet = merchantMeta({
  method: "get",
  path: "/m/me/overview",
  operationId: "m.me.overview.get",
  summary:
    "“我的”页聚合：当前门店卡（认证状态、城市品类、角色、档案摘要、审核中提示）、套餐与积分卡（仅老板）、我的门店数与额度、当前门店概览（上线中/交付中/选剧单）、各入口副标题与角标",
  "x-capability": "me.*",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
