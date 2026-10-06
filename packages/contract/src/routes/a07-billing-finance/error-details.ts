import type { DomainErrorSymbol } from "../../errors/index.js";
import { DictRefSchema } from "../../common/index.js";
import { z } from "../../zod.js";
export const A07_ERROR_DETAILS = {
  TRANSFER_AMOUNT_MISMATCH: z.object({ amountFen: z.int().nonnegative() }),
  BANK_SERIAL_DUPLICATE: z.object({
    conflicts: z.array(z.object({ ref: z.string(), payerBank: DictRefSchema.nullable() })),
  }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
