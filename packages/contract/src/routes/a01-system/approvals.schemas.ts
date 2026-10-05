// 审批的结构（docs/api/a01-system.md 第 2.10 节；03 分组 第 4 节）。W1-06 的第一个 PR 只交 ApprovalSummary：
// approval.submit 拿它校验各 kind 的处理器生成的摘要。ApprovalItem、ApprovalDetail、ApprovalCounts、
// ApprovalDecisionView 随读侧三条接口在第二个 PR 交，仍放本文件。
import { FenSchema, IdSchema, PointsSchema } from "../../common/index.js";
import { z } from "../../zod.js";

/** 审批单的大类（approval_request.category）：review 商家提交的审核，approval 员工发起的审批 */
export const APPROVAL_CATEGORIES = ["review", "approval"] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

/** 有执行步的四类（03 分组 第 3.2 节）：审批单停在 approved，执行在领域表；它们不填在途去重键 */
export const APPROVAL_EXECUTION_KINDS = [
  "order_cancel",
  "ad_cancel",
  "qualification_cancel",
  "plan_refund",
] as const;
export type ApprovalExecutionKind = (typeof APPROVAL_EXECUTION_KINDS)[number];

/** 摘要里的一行键值：已脱敏的展示文本，不放证照号、银行账号、凭证图片等明文 */
export const ApprovalSummaryLineSchema = z.strictObject({
  label: z.string().min(1).max(20),
  value: z.string().max(200),
});

/**
 * approval_request.summary_snapshot：提交时由该 kind 登记的处理器生成，之后不变（03 分组 第 4 节）。
 * 各 kind 的 lines 写什么由登记它的接口文档定；这里是全部 kind 共有的形状，登记方可以另给更窄的 schema。
 * amountFen、points 只作展示与排序，真相在领域表；domain 是一对一领域行的最终表名与 id。
 */
export const ApprovalSummarySchema = z.strictObject({
  /** 队列行标题：库的 CHECK 要求必有 */
  title: z.string().min(1).max(120),
  lines: z.array(ApprovalSummaryLineSchema).max(20).optional(),
  amountFen: FenSchema.optional(),
  points: PointsSchema.optional(),
  domain: z.strictObject({ type: z.string().regex(/^[a-z][a-z0-9_]*$/), id: IdSchema }).optional(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;
