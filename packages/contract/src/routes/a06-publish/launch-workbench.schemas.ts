import { z } from "../../zod.js";
import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  orNull,
} from "../../common/index.js";
import { adminPage } from "../a01-system/structures.js";
import { FollowUpItemSchema } from "../a03-merchant/follow-ups.schemas.js";
import { AdminStoreBriefSchema } from "../a05-order-delivery/public.schemas.js";
import { ChannelAccountBriefSchema } from "../m05-delivery-publish/publish.schemas.js";
import {
  LaunchTaskBriefSchema,
  OrderItemBriefSchema,
  TicketBriefSchema,
} from "./publish.schemas.js";

const count = z.int().nonnegative();
const queryBool = z.stringbool({ truthy: ["true"], falsy: ["false"] }).openapi({ type: "boolean" });
const filters = {
  days: z.coerce.number().int().min(1).max(30).default(7),
  managerId: IdSchema.optional(),
  deliveryTicketId: IdSchema.optional(),
  orderItemId: IdSchema.optional(),
  readyOnly: queryBool.default(false),
  q: z.string().min(1).max(64).optional(),
};
export const LaunchCalendarQuerySchema = z
  .strictObject({
    month: z
      .string()
      .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
      .optional(),
    from: DateSchema.optional(),
    to: DateSchema.optional(),
    managerId: IdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine(
    (q) =>
      q.month !== undefined
        ? q.from === undefined && q.to === undefined
        : q.from !== undefined &&
          q.to !== undefined &&
          q.from <= q.to &&
          (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 42,
    {
      message: "month 或 from/to 二选一，区间最多包含 42 天",
    },
  );
export const AdminLaunchTaskListQuerySchema = z.strictObject({
  ...filters,
  ...PageQuerySchema.shape,
  tab: z.enum(["overdue", "upcoming", "all"]).default("overdue"),
});
export const LaunchTaskSummaryQuerySchema = z.strictObject(filters);
export const LaunchCalendarItemSchema = z
  .strictObject({
    orderItemId: IdSchema,
    ticket: TicketBriefSchema,
    store: AdminStoreBriefSchema,
    dramaTitle: z.string(),
    episodeCount: z.int().positive(),
    agreedLaunchDate: DateSchema,
    isDateTentative: z.boolean(),
    calendarStatus: z.enum(["producing", "to_launch", "verifying", "overdue"]),
    accounts: z.array(ChannelAccountBriefSchema),
    tasks: z.array(LaunchTaskBriefSchema),
    isDeliveryLate: z.boolean(),
    overdueDays: count.nullable(),
    latestFollowUp: orNull(FollowUpItemSchema),
    actions: z.array(z.literal("remind")),
  })
  .openapi("LaunchCalendarItem");
export const LaunchCalendarSchema = z
  .strictObject({
    from: DateSchema,
    to: DateSchema,
    today: DateSchema,
    stats: z.strictObject({
      total: count,
      producing: count,
      toLaunch: count,
      verifying: count,
      overdue: count,
    }),
    days: z.array(z.strictObject({ date: DateSchema, items: z.array(LaunchCalendarItemSchema) })),
    total: count,
    isTruncated: z.boolean(),
  })
  .openapi("LaunchCalendar");
export const LaunchTrackItemSchema = z
  .strictObject({
    orderItem: OrderItemBriefSchema,
    ticket: TicketBriefSchema,
    store: AdminStoreBriefSchema,
    isDelivered: z.boolean(),
    overdue: z
      .strictObject({
        startDate: DateSchema,
        days: count,
        reason: z.enum(["merchant", "late_delivery"]),
      })
      .nullable(),
    daysUntilLaunch: count.nullable(),
    tasks: z.array(LaunchTaskBriefSchema),
    followUpCount: count,
    followUps: z.array(FollowUpItemSchema).max(3),
    lastRemindedAt: InstantSchema.nullable(),
    isRemindedToday: z.boolean(),
    actions: z.array(z.literal("remind")),
  })
  .openapi("LaunchTrackItem");
export const LaunchTrackPageSchema = adminPage(LaunchTrackItemSchema).openapi("LaunchTrackPage");
export const LaunchTrackSummarySchema = z
  .strictObject({
    overdue: count,
    upcoming: count,
    deliveringSoon: count,
    all: count,
    last30Days: z.strictObject({
      overdueItemCount: count,
      avgOverdueDays: z.number().nonnegative(),
      liveItemCount: count,
    }),
  })
  .openapi("LaunchTrackSummary");
export type LaunchCalendarQuery = z.infer<typeof LaunchCalendarQuerySchema>;
export type LaunchTaskListQuery = z.infer<typeof AdminLaunchTaskListQuerySchema>;
export type LaunchTaskSummaryQuery = z.infer<typeof LaunchTaskSummaryQuerySchema>;
export type LaunchTrackItem = z.infer<typeof LaunchTrackItemSchema>;
export type LaunchCalendarItem = z.infer<typeof LaunchCalendarItemSchema>;
