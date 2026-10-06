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
  STORE_NOT_QUALIFIED: z.object({
    storeId: IdSchema,
    reason: openEnum(["not_submitted", "pending_review", "rejected", "final_rejected"]),
  }),
  ORDER_ACCOUNT_INVALID: z.object({
    channelAccountId: IdSchema,
    reason: openEnum(["not_in_store", "not_available"]),
  }),
  ORDER_AD_INVALID: z.object({
    adId: IdSchema,
    reason: openEnum([
      "not_in_store",
      "not_confirmed",
      "cancelled",
      "cancel_pending",
      "slot_not_allowed",
    ]),
    dramaId: IdSchema.optional(),
  }),
  LAUNCH_DATE_TOO_EARLY: z.object({ earliestLaunchDate: z.iso.date() }),
  DRAMA_NOT_ORDERABLE: z.object({ dramaId: IdSchema, reason: openEnum(UNORDERABLE_REASONS) }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
export type DramaNotOrderableDetails = z.infer<typeof M04_ERROR_DETAILS.DRAMA_NOT_ORDERABLE>;
