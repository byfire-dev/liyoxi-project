// m04 §2.4、2.6、2.8 与 §3.10–3.20：选剧单与历史订单读侧。
import { z } from "../../zod.js";
import {
  IdSchema,
  InstantSchema,
  DateSchema,
  CursorQuerySchema,
  cursorPage,
  orNull,
  openEnum,
} from "../../common/index.js";
import { CHANNEL_ACCOUNT_ACCOUNT_TYPE } from "../../enums/index.js";
import { DramaCardSchema } from "./mall.schemas.js";
import { OrderDetailSchema, OrderItemInOrderSchema, OrderTodoSchema } from "./order.schemas.js";
const count = z.int().nonnegative();
export const CartItemSchema = z
  .object({
    cartItemId: IdSchema,
    drama: DramaCardSchema,
    state: openEnum(["valid", "price_changed", "invalid"]),
    invalidReason: orNull(openEnum(["not_listed", "stopped"])),
    snapshotPricePoints: count,
    currentPricePoints: count.nullable(),
    discountedPoints: count.nullable(),
    addedAt: InstantSchema,
    priceAckedAt: InstantSchema.nullable(),
    actions: z.array(z.string()),
  })
  .openapi("CartItem");
export const CartListSchema = z
  .object({
    items: z.array(CartItemSchema).max(50),
    limit: z.literal(50),
    plan: orNull(z.object({ planName: z.string(), discountBp: count })),
    spendablePoints: count,
  })
  .openapi("CartList");
export const CartCreateBodySchema = z.object({ dramaId: IdSchema }).openapi("CartCreateBody");
export const CartAcceptBodySchema = z
  .object({ acceptedPricePoints: z.int().positive() })
  .openapi("CartAcceptBody");
export const CartAcceptResultSchema = CartItemSchema.extend({ replayed: z.boolean() }).openapi(
  "CartItemAcceptResult",
);
export const MerchantOrderListQuerySchema = CursorQuerySchema.extend({
  tab: z.enum(["all", "producing", "to_launch", "live", "ended", "after_sale"]).default("all"),
  no: z.string().min(1).optional(),
}).openapi("MerchantOrderListQuery");
export const OrderCardSchema = OrderDetailSchema.pick({
  orderId: true,
  orderNo: true,
  submittedAt: true,
  status: true,
  subStatus: true,
  tab: true,
  itemCount: true,
  totalChargePoints: true,
  actions: true,
})
  .extend({
    firstDramaTitle: z.string(),
    platforms: z.array(z.string()),
    pinnedTodo: orNull(OrderTodoSchema),
    liveSummary: orNull(
      z.object({
        liveItemCount: count,
        liveEpisodeCount: count,
        earliestUsageEndDate: DateSchema,
        firstLiveOrderItemId: IdSchema,
      }),
    ),
    returnedPoints: count,
  })
  .openapi("OrderCard");
export const MerchantOrderListSchema = cursorPage(OrderCardSchema).openapi("MerchantOrderList");
export const MerchantOrderItemQuerySchema = CursorQuerySchema.extend({
  tab: z.enum(["all", "live", "to_launch", "ended"]).default("all"),
  orderId: IdSchema.optional(),
}).openapi("MerchantOrderItemQuery");
export const MerchantOrderItemSummaryQuerySchema = z
  .object({ orderId: IdSchema.optional() })
  .openapi("MerchantOrderItemSummaryQuery");
const itemHeader = OrderItemInOrderSchema.pick({
  orderItemId: true,
  dramaId: true,
  dramaTitle: true,
  posterUrl: true,
  genres: true,
  episodeCount: true,
  phase: true,
  ticketStep: true,
  accounts: true,
  agreedLaunchDate: true,
  usageStartDate: true,
  usageEndDate: true,
  liveEpisodeCount: true,
}).extend({ orderId: IdSchema, orderNo: z.string(), remainingDays: count.nullable() });
export const OrderItemRowSchema = itemHeader
  .extend({ pendingTodo: orNull(OrderTodoSchema) })
  .openapi("OrderItemRow");
export const OrderItemDetailSchema = itemHeader
  .extend({
    phaseChangedAt: InstantSchema,
    usageEndSource: OrderItemInOrderSchema.shape.usageEndSource,
    accounts: z.array(
      OrderItemInOrderSchema.shape.accounts.element.extend({
        accountUid: z.string(),
        accountType: orNull(openEnum(CHANNEL_ACCOUNT_ACCOUNT_TYPE.values)),
      }),
    ),
  })
  .openapi("OrderItemDetail");
export const MerchantOrderItemListSchema =
  cursorPage(OrderItemRowSchema).openapi("MerchantOrderItemList");
export const OrderItemSummarySchema = z
  .object({ all: count, live: count, to_launch: count, ended: count, delivering: count })
  .openapi("OrderItemSummary");
export type CartItem = z.infer<typeof CartItemSchema>;
export type MerchantOrderListQuery = z.infer<typeof MerchantOrderListQuerySchema>;
export type MerchantOrderItemQuery = z.infer<typeof MerchantOrderItemQuerySchema>;
export type OrderCard = z.infer<typeof OrderCardSchema>;
export type OrderItemRow = z.infer<typeof OrderItemRowSchema>;
export type OrderItemDetail = z.infer<typeof OrderItemDetailSchema>;
