// 商家端：交付与发布 · delivery-plans（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mDeliveryPlanGet = merchantMeta({
  method: "get",
  path: "/m/delivery-plans/{deliveryPlanId}",
  operationId: "m.deliveryPlan.get",
  summary:
    "方案确认页：状态（待确认/修改中/已确认）、当前版本内容、推送人与时间、修改请求记录、剧目与上线账号、定制内容、植入形式与广告、上线安排",
  "x-capability": "order.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mDeliveryPlanConfirm = merchantMeta({
  method: "post",
  path: "/m/delivery-plans/{deliveryPlanId}/confirm",
  operationId: "m.deliveryPlan.confirm",
  summary: "确认方案 {versionNo}：内容落到订单项、发布账号、广告位绑定，推进交付工单",
  "x-capability": "delivery.confirm_plan",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mDeliveryPlanRequestChange = merchantMeta({
  method: "post",
  path: "/m/delivery-plans/{deliveryPlanId}/request-change",
  operationId: "m.deliveryPlan.requestChange",
  summary:
    "联系服务经理修改 / 补充修改意见：{kinds[]（上线日期、上线账号、定制内容、植入形式、广告视频、其他）, note ≤200}",
  "x-capability": "delivery.confirm_plan",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
