// 商家端：商城、选剧单与订购 · todos（docs/api/m04-mall-order.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mTodoList = merchantMeta({
  method: "get",
  path: "/m/todos",
  operationId: "m.todo.list",
  summary:
    "待办（?limit=&cursor=&orderId=&orderItemId=；首页最多 3 条、订单卡片置顶）：方案/广告/样片待确认、上线待回填或需补充、下架待确认、账号核验未通过、资质被驳回、工单待您确认、素材需求；按紧急度排序，游标分页",
  "x-capability": "todo.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
