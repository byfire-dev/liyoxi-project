// 后台：商家、资质审核与素材复核 · entities（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminEntityGet = adminMeta({
  method: "get",
  path: "/admin/entities/{entityId}",
  operationId: "admin.entity.get",
  summary:
    "主体卡片与名下门店（门店与成员页签）：信用代码脱敏、认证日期、老板、套餐、门店与成员用量",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminEntityClose = adminMeta({
  method: "post",
  path: "/admin/entities/{entityId}/close",
  operationId: "admin.entity.close",
  summary: "后台关闭经营主体：撤回邀请、移除成员、停用门店、吊销下载页会话",
  "x-permission": "merchant.entity.close",
  "x-idempotent": "required",
});

export const adminEntityMemberList = adminMeta({
  method: "get",
  path: "/admin/entities/{entityId}/members",
  operationId: "admin.entity.member.list",
  summary: "主体成员（只读：成员由老板在小程序邀请和管理；待接受的邀请随 admin.entity.get 返回）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminEntityQuotaUpdate = adminMeta({
  method: "patch",
  path: "/admin/entities/{entityId}/quota",
  operationId: "admin.entity.quota.update",
  summary: "门店数、成员数上限覆盖（大客户）",
  "x-permission": "merchant.quota.override",
  "x-idempotent": "required",
});
