// 后台：商家、资质审核与素材复核 · follow-ups（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminFollowUpList = adminMeta({
  method: "get",
  path: "/admin/follow-ups",
  operationId: "admin.followUp.list",
  summary: "跟进记录：按对象（门店、续费周期、逾期订单项、巡检、下架、补发）或主体、门店查询时间线",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminFollowUpCreate = adminMeta({
  method: "post",
  path: "/admin/follow-ups",
  operationId: "admin.followUp.create",
  summary: "记录跟进：方式、内容、续费意向（仅续费）、下次跟进时间；同对象此前在办的跟进同事务关闭",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminFollowUpSummary = adminMeta({
  method: "get",
  path: "/admin/follow-ups/summary",
  operationId: "admin.followUp.summary",
  summary: "跟进记录计数（商家详情“跟进记录”页签角标）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminFollowUpUpdate = adminMeta({
  method: "patch",
  path: "/admin/follow-ups/{followUpId}",
  operationId: "admin.followUp.update",
  summary: "改下次跟进时间（带 lockVersion）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminFollowUpComplete = adminMeta({
  method: "post",
  path: "/admin/follow-ups/{followUpId}/complete",
  operationId: "admin.followUp.complete",
  summary: "标记跟进事项完成（可填完成说明）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
