// 后台：订购、取消、交付与广告任务 · order-items（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminOrderItemDownloadList = adminMeta({
  method: "get",
  path: "/admin/order-items/{orderItemId}/downloads",
  operationId: "admin.orderItem.download.list",
  summary: "成片包、下载授权与下载记录（排障与证据）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminOrderItemLicenseLetterList = adminMeta({
  method: "get",
  path: "/admin/order-items/{orderItemId}/license-letters",
  operationId: "admin.orderItem.licenseLetter.list",
  summary: "订单项的定制内容授权书（每个发布账号一份）与当前版次文件",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminOrderItemRescheduleLaunch = adminMeta({
  method: "post",
  path: "/admin/order-items/{orderItemId}/reschedule-launch",
  operationId: "admin.orderItem.rescheduleLaunch",
  summary: "改约定上线日（首个账号核验通过前可改；写审计）",
  "x-permission": "delivery.plan.reschedule",
  "x-idempotent": "required",
});
