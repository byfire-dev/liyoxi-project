import { z } from "../../zod.js";
import { IdSchema, InstantSchema, CursorQuerySchema } from "../../common/index.js";
import { adminCursorPage } from "../a01-system/structures.js";
import { ActivityItemSchema } from "../a04-content/drama-lifecycle.schemas.js";

export const AdminOrderQuoteBodySchema = z
  .strictObject({
    dramaId: IdSchema,
    planCode: z.string().min(1).max(64),
    isTopModel: z.boolean().default(false),
  })
  .openapi("AdminOrderQuoteBody");
export const OrderQuoteResultSchema = z
  .strictObject({
    quotedAt: InstantSchema,
    dramaId: IdSchema,
    dramaTitle: z.string(),
    heatTier: z.enum(["S", "A", "B", "C"]).nullable(),
    priceMode: z.enum(["template", "custom"]),
    listPricePoints: z.int().nonnegative().nullable(),
    planCode: z.string(),
    planName: z.string(),
    discountBp: z.int().nonnegative(),
    productionModel: z.enum(["standard", "advanced", "top"]),
    isTopModelSelected: z.boolean(),
    surchargeBp: z.int().nonnegative(),
    discountedPoints: z.int().nonnegative().nullable(),
    chargePoints: z.int().nonnegative().nullable(),
    formula: z.string().nullable(),
    orderable: z.boolean(),
    unorderableReason: z.string().nullable(),
  })
  .openapi("OrderQuoteResult");
export const OrderActivityQuerySchema = CursorQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
  .strict()
  .openapi("OrderActivityQuery");
export const OrderActivityPageSchema =
  adminCursorPage(ActivityItemSchema).openapi("OrderActivityPage");
export type AdminOrderQuoteBody = z.infer<typeof AdminOrderQuoteBodySchema>;
export type OrderActivityQuery = z.infer<typeof OrderActivityQuerySchema>;
