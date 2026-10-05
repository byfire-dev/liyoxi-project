// 后台：内容运营与通知配置 · wx-template-slots（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminWxTemplateSlotList = adminMeta({
  method: "get",
  path: "/admin/wx-template-slots",
  operationId: "admin.wxTemplateSlot.list",
  summary: "订阅消息模板槽位：绑定的模板 ID、状态、连续失败数",
  "x-permission": "sys.super_admin",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminWxTemplateSlotUpdate = adminMeta({
  method: "patch",
  path: "/admin/wx-template-slots/{slotKey}",
  operationId: "admin.wxTemplateSlot.update",
  summary: "绑定或更换订阅消息模板 ID（字段定义须与场景一致）",
  "x-permission": "sys.super_admin",
  "x-idempotent": "required",
});

export const adminWxTemplateSlotDisable = adminMeta({
  method: "post",
  path: "/admin/wx-template-slots/{slotKey}/disable",
  operationId: "admin.wxTemplateSlot.disable",
  summary: "人工停用槽位",
  "x-permission": "sys.super_admin",
  "x-idempotent": "required",
});

export const adminWxTemplateSlotEnable = adminMeta({
  method: "post",
  path: "/admin/wx-template-slots/{slotKey}/enable",
  operationId: "admin.wxTemplateSlot.enable",
  summary: "重新启用被自动或人工停用的槽位（fail_streak 清零）",
  "x-permission": "sys.super_admin",
  "x-idempotent": "required",
});
