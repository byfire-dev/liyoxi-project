import type { DomainErrorSymbol } from "../../errors/index.js";
import { IdSchema, InstantSchema } from "../../common/index.js";
import { z } from "../../zod.js";
import {
  PlanQuoteSchema,
  PurchaseChannelSchema,
  PurchasePolicySchema,
} from "./purchase.schemas.js";
const n = z.int().nonnegative();
const order = z.object({ paymentOrderId: IdSchema, orderNo: z.string() });
export const M07_ERROR_DETAILS = {
  CYCLE_NOT_AVAILABLE: z.object({ enabledCycles: z.array(z.int().positive()) }),
  UPGRADE_NOT_ALLOWED_TODAY: z.object({ suggest: z.literal("renew_next_term") }),
  SCHEDULED_TERM_LIMIT: z.object({ maxScheduledTerms: n }),
  QUOTE_CHANGED: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("plan"), amountFen: n, quote: PlanQuoteSchema }),
    z.object({
      kind: z.literal("topup"),
      amountFen: n,
      pointPack: z.object({ pointPackId: IdSchema, points: n, priceFen: n }),
    }),
    z.object({
      kind: z.literal("points"),
      totalChargePoints: n,
      items: z.array(z.object({ dramaId: IdSchema.nullable(), chargePoints: n })),
    }),
  ]),
  POINTS_INSUFFICIENT: z.object({ requiredPoints: n, spendablePoints: n, shortfallPoints: n }),
  PURCHASE_NOT_OFFERED: z.object({ mode: PurchasePolicySchema.shape.mode }),
  CHANNEL_NOT_ALLOWED: z.object({ channels: z.array(PurchaseChannelSchema) }),
  PURCHASE_QUALIFICATION_REQUIRED: z.object({ verificationStatus: z.string() }),
  OPEN_ORDER_EXISTS: order,
  OPEN_ORDER_EXPIRING: order.extend({ expiresAt: InstantSchema }),
  PAYMENT_ORDER_EXPIRED: z.object({ expiresAt: InstantSchema }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
