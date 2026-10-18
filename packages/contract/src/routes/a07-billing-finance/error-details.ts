import type { DomainErrorSymbol } from "../../errors/index.js";
import { DateSchema, DictRefSchema, IdSchema, orNull } from "../../common/index.js";
import { PlanRevisionViewSchema } from "./plans.schemas.js";
import { z } from "../../zod.js";
export const A07_ERROR_DETAILS = {
  PLAN_REVISION_MISSING: z.object({ missingCycles: z.array(z.int().positive()) }),
  REVISION_PENDING_EXISTS: z.object({ revision: PlanRevisionViewSchema }),
  NOTICE_PERIOD_REQUIRED: z.object({
    earliestEffectiveDate: DateSchema,
    keys: z.array(z.string()).optional(),
  }),
  PARAM_PENDING_EXISTS: z.object({
    items: z.array(
      z.object({ key: z.string(), billingParamId: IdSchema, effectiveAt: z.string() }),
    ),
  }),
  PLAN_RANK_TAKEN: z.object({ planId: IdSchema, rank: z.int().positive() }),
  PLAN_TIER_ORDER_INVALID: z.object({
    planId: IdSchema,
    name: z.string(),
    fields: z.array(z.string()),
    effectiveAt: z.string(),
  }),
  TRANSFER_AMOUNT_MISMATCH: z.object({ amountFen: z.int().nonnegative() }),
  BANK_SERIAL_DUPLICATE: z.object({
    conflicts: z.array(z.object({ ref: z.string(), payerBank: orNull(DictRefSchema) })),
  }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
