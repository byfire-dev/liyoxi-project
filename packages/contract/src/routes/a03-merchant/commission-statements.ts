// 后台：商家、资质审核与素材复核 · commission-statements（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminCommissionStatementList = adminMeta({
  method: "get",
  path: "/admin/commission-statements",
  operationId: "admin.commissionStatement.list",
  summary: "返佣结算单列表（按月份、状态；当月为预估）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCommissionStatementSummary = adminMeta({
  method: "get",
  path: "/admin/commission-statements/summary",
  operationId: "admin.commissionStatement.summary",
  summary: "结算单月度汇总卡（应付、已打款、待打款、异议）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCommissionStatementGet = adminMeta({
  method: "get",
  path: "/admin/commission-statements/{commissionStatementId}",
  operationId: "admin.commissionStatement.get",
  summary: "结算单详情与处理记录",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCommissionStatementLineList = adminMeta({
  method: "get",
  path: "/admin/commission-statements/{commissionStatementId}/lines",
  operationId: "admin.commissionStatement.line.list",
  summary: "结算明细（付款单逐笔）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCommissionStatementRecordPayout = adminMeta({
  method: "post",
  path: "/admin/commission-statements/{commissionStatementId}/record-payout",
  operationId: "admin.commissionStatement.recordPayout",
  summary: "登记服务商返佣打款（转账日期、银行流水号、回单；通知服务商）",
  "x-permission": null,
  "x-idempotent": "required",
});

export const adminCommissionStatementReplyDispute = adminMeta({
  method: "post",
  path: "/admin/commission-statements/{commissionStatementId}/reply-dispute",
  operationId: "admin.commissionStatement.replyDispute",
  summary: "回复服务商异议并重新推送确认",
  "x-permission": null,
  "x-idempotent": "required",
});
