// FILE_NOT_USABLE 的统一出口：W1-07 定义，全部业务引用方按同一理由表取值。
import type { DomainErrorSymbol } from "../../errors/index.js";
import { IdSchema, openEnum } from "../../common/index.js";
import { z } from "../../zod.js";
import { MissingItemSchema } from "./profile.schemas.js";

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
  INDUSTRY_NOT_OPEN: z.object({ field: z.string(), code: z.string() }),
  REVIEW_REQUIRED: z.object({ changedFields: z.array(z.string()) }),
  STORE_PROFILE_INCOMPLETE: z.object({
    missing: z.array(MissingItemSchema.extend({ step: z.int().min(1).max(4) })),
  }),
  DECLARATION_REQUIRED: z.object({ currentVersion: z.string() }),
  QUALIFICATION_DOCS_INCOMPLETE: z.object({
    rejectedNotReplaced: z
      .array(z.object({ docType: z.string(), permitType: z.string().nullable() }))
      .optional(),
  }),
  FILE_NOT_USABLE: z.object({
    fileIds: z.array(IdSchema),
    reason: openEnum(FILE_NOT_USABLE_REASONS),
  }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
export type FileNotUsableDetails = z.infer<(typeof M03_ERROR_DETAILS)["FILE_NOT_USABLE"]>;
