// 后台：内容运营与通知配置 · notification-deliveries（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminNotificationDeliveryList = adminMeta({
  method: "get",
  path: "/admin/notification-deliveries",
  operationId: "admin.notificationDelivery.list",
  summary: "发送日志：场景、通道、状态、业务对象、接收人、时间范围（页码分页；手机号脱敏）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminNotificationDeliveryResend = adminMeta({
  method: "post",
  path: "/admin/notification-deliveries/{notificationDeliveryId}/resend",
  operationId: "admin.notificationDelivery.resend",
  summary: "手动重发失败或跳过的外部通道投递（填原因；照常过守卫与限频）",
  "x-permission": "notify.resend",
  "x-idempotent": "required",
});
