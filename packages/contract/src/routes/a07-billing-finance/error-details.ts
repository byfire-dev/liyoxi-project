import type { DomainErrorSymbol } from "../../errors/index.js";
import { DictRefSchema, orNull } from "../../common/index.js";
import { z } from "../../zod.js";
export const A07_ERROR_DETAILS = {
  PLAN_REVISION_MISSING: z.object({ missingCycles: z.array(z.int().positive()) }),
  TRANSFER_AMOUNT_MISMATCH: z.object({ amountFen: z.int().nonnegative() }),
  BANK_SERIAL_DUPLICATE: z.object({
    conflicts: z.array(z.object({ ref: z.string(), payerBank: orNull(DictRefSchema) })),
  }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
