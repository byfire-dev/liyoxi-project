// a03-merchant 定义的、带 details 的领域错误码的结构（docs/api/a03-merchant.md 第 5 节），按符号名关联。
// 纯常量一侧（errors/domain/a03-merchant.ts）只标“带不带 details”；这里放 Zod 结构，同一个码的 details 类型唯一（约定 C22）。
// 先到的包新建本文件，后到的只往对象末尾加自己的码（docs/plan/tasks/README.md 第 7.3 节）。
// 审批段的两个码（48201、48203）由 approval 模块抛出，别的文档的决定、撤回接口只引符号名（约定 C28）。
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
import type { DomainErrorSymbol } from "../../errors/index.js";
import { APPROVAL_STATUS } from "../../enums/shared.js";
import { zodEnum } from "../../enums/zod.js";
import { z } from "../../zod.js";

export const A03_ERROR_DETAILS = {
  QUALIFICATION_CHECK_FAILED: z.object({
    items: z.array(z.object({ qualificationDocId: IdSchema, code: z.string(), field: z.string() })),
  }),
  STORE_MANAGER_ASSIGNED: z.object({ deliveryManagerId: IdSchema }),
  /** 审批单此刻的状态与进入终态的时间 */
  APPROVAL_NOT_PENDING: z.object({
    status: zodEnum(APPROVAL_STATUS),
    decidedAt: orNull(InstantSchema),
  }),
  /** 在审的那一张：审批单 id 与业务单号（没有单号的类型为 null） */
  APPROVAL_ALREADY_PENDING: z.object({
    approvalId: IdSchema,
    requestNo: orNull(z.string()),
  }),
  FIELD_NOT_PROXY_EDITABLE: z.object({ fields: z.array(z.string()) }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;

export type ApprovalNotPendingDetails = z.infer<(typeof A03_ERROR_DETAILS)["APPROVAL_NOT_PENDING"]>;
export type ApprovalAlreadyPendingDetails = z.infer<
  (typeof A03_ERROR_DETAILS)["APPROVAL_ALREADY_PENDING"]
>;
