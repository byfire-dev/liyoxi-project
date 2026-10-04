// 带 details 的通用错误码的 Zod 结构（约定 C27 的第二张表），按符号名关联。
// 纯常量一侧（errors/common.ts）只标“带不带 details”与类型；这里放结构。契约自测保证两边一致。
import { z } from "../zod.js";

import type { CommonErrorDetails } from "../errors/index.js";
import { DateSchema } from "./scalars.js";

/** 占位：PendingConsent 归 m01（约定 C87），随 m01 的第一个后端 PR 定义后替换 */
export const PendingConsentPlaceholderSchema = z.record(z.string(), z.unknown());

export const COMMON_ERROR_DETAILS = {
  CONSENT_REQUIRED: z.object({ pendingConsents: z.array(PendingConsentPlaceholderSchema) }),
  REMINDED_TODAY: z.object({ scene: z.string(), nextAvailableDate: DateSchema }),
} satisfies { [K in keyof CommonErrorDetails]: z.ZodType<CommonErrorDetails[K]> };
