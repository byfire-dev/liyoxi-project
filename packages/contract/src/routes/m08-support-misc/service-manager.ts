// 商家端：客服、消息与通用接口 · service-manager（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mServiceManagerGet = merchantMeta({
  method: "get",
  path: "/m/service-manager",
  operationId: "m.serviceManager.get",
  summary: "当前门店的专属服务经理名片：姓名、岗位、企业微信“联系我”二维码、电话、工作时间",
  "x-capability": "support.manager.read",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
