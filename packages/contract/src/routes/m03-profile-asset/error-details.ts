// FILE_NOT_USABLE 的统一出口：W1-07 定义，全部业务引用方按同一理由表取值。
import type { DomainErrorSymbol } from "../../errors/index.js";
import { IdSchema, openEnum } from "../../common/index.js";
import { z } from "../../zod.js";

export const FILE_NOT_USABLE_REASONS = [
  "not_stored",
  "category_mismatch",
  "scope_mismatch",
  "blocked",
  "duplicate",
  "ext_mismatch",
  "context_mismatch",
] as const;
export const M03_ERROR_DETAILS = {
  FILE_NOT_USABLE: z.object({
    fileIds: z.array(IdSchema),
    reason: openEnum(FILE_NOT_USABLE_REASONS),
  }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
export type FileNotUsableDetails = z.infer<(typeof M03_ERROR_DETAILS)["FILE_NOT_USABLE"]>;
