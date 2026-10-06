import type { DomainErrorSymbol } from "../../errors/index.js";
import { IdSchema, openEnum } from "../../common/index.js";
import { z } from "../../zod.js";
export const UNORDERABLE_REASONS = [
  "not_listed",
  "stopped",
  "platform_not_licensed",
  "permit_missing",
] as const;
export const M04_ERROR_DETAILS = {
  DRAMA_NOT_ORDERABLE: z.object({ dramaId: IdSchema, reason: openEnum(UNORDERABLE_REASONS) }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
export type DramaNotOrderableDetails = z.infer<typeof M04_ERROR_DETAILS.DRAMA_NOT_ORDERABLE>;
