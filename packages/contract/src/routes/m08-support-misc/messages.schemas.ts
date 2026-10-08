import {
  CursorQuerySchema,
  DateSchema,
  IdSchema,
  InstantSchema,
  cursorPage,
  openEnum,
  orNull,
} from "../../common/index.js";
import { z } from "../../zod.js";
import { MERCHANT_MESSAGE_CATEGORY } from "../../enums/index.js";
import { BannerPageJumpSchema } from "../m04-mall-order/banner.schemas.js";

export const MESSAGE_TABS = [
  "all",
  "order",
  "delivery",
  "launch",
  "plan_points",
  "review",
  "store",
  "service",
] as const;
export const MessageTabSchema = z.enum(MESSAGE_TABS);
// a09 §2.9 / m07 的 paymentOrderId；无对象的账号安全消息固定落消息中心。
export const MessageDeepLinkSchema = z.union([
  BannerPageJumpSchema,
  z.strictObject({
    route: z.literal("asset.detail"),
    params: z.strictObject({ storeAssetId: IdSchema, storeId: IdSchema }),
  }),
  z.strictObject({
    route: z.literal("agreement.view"),
    params: z.strictObject({
      key: z.enum(["user", "privacy", "member", "points", "custom_license", "ad_service"]),
    }),
  }),
  z.strictObject({
    route: z.literal("payment.result"),
    params: z.strictObject({ paymentOrderId: IdSchema }),
  }),
  z.strictObject({
    route: z.literal("payment.detail"),
    params: z.strictObject({ paymentOrderId: IdSchema }),
  }),
  z.strictObject({ route: z.literal("points.ledger"), params: z.strictObject({}) }),
  z.strictObject({ route: z.literal("messages.list"), params: z.strictObject({}) }),
]);
export const MessageItemSchema = z.strictObject({
  messageId: IdSchema,
  category: openEnum(MERCHANT_MESSAGE_CATEGORY.values),
  title: z.string().max(40),
  body: z.string().max(200),
  ctaText: orNull(z.string().max(12)),
  link: MessageDeepLinkSchema,
  storeId: orNull(IdSchema),
  isRead: z.boolean(),
  readAt: orNull(InstantSchema),
  createdAt: InstantSchema,
  createdDate: DateSchema,
});
export const MessageListQuerySchema = CursorQuerySchema.extend({
  tab: MessageTabSchema.default("all"),
});
export const MessageListResultSchema = cursorPage(MessageItemSchema);
export const MessageSummarySchema = z.strictObject({
  total: z.int().nonnegative(),
  byTab: z
    .array(z.strictObject({ tab: MessageTabSchema, unreadCount: z.int().nonnegative() }))
    .length(8)
    .refine(
      (items) => items.every((item, i) => item.tab === MESSAGE_TABS[i]),
      "页签须按正式八项次序返回",
    ),
  byStore: z.array(z.strictObject({ storeId: IdSchema, unreadCount: z.int().nonnegative() })),
});
export const MessageBatchReadBodySchema = z.strictObject({
  upToMessageId: IdSchema,
  tab: MessageTabSchema.default("all"),
});
export const MessageBatchReadResultSchema = z.strictObject({
  markedCount: z.int().nonnegative(),
  summary: MessageSummarySchema,
});
export const MessageReadParamsSchema = z.object({ messageId: IdSchema });
export const MessageReadResultSchema = z.strictObject({
  messageId: IdSchema,
  readAt: InstantSchema,
});
export type MessageTab = z.infer<typeof MessageTabSchema>;
export type MessageItem = z.infer<typeof MessageItemSchema>;
export type MessageSummary = z.infer<typeof MessageSummarySchema>;
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;
export type MessageBatchReadBody = z.infer<typeof MessageBatchReadBodySchema>;
