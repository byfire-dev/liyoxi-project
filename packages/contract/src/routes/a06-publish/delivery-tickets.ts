// 后台：发布与巡检 · delivery-tickets（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDeliveryTicketPublishListGet = adminMeta({
  method: "get",
  path: "/admin/delivery-tickets/{deliveryTicketId}/publish-list",
  operationId: "admin.deliveryTicket.publishList.get",
  summary: "发布清单：合集名称、封面、每集标题模板与逐集标题、话题、简介；交付前检查项",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDeliveryTicketPublishListReplace = adminMeta({
  method: "put",
  path: "/admin/delivery-tickets/{deliveryTicketId}/publish-list",
  operationId: "admin.deliveryTicket.publishList.replace",
  summary: "保存发布清单（带 lockVersion）",
  "x-permission": "publish.list.edit",
  "x-idempotent": "required",
});

export const adminDeliveryTicketPublishListImport = adminMeta({
  method: "post",
  path: "/admin/delivery-tickets/{deliveryTicketId}/publish-list/import",
  operationId: "admin.deliveryTicket.publishList.import",
  summary: "表格导入逐集标题与看点（行级校验）",
  "x-permission": "publish.list.edit",
  "x-idempotent": "required",
});
