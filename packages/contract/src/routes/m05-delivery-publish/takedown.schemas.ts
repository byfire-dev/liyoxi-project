// W6-04：m05 §3.21–3.23。商家卡片与后台行各自保持冻结字段名。
import { z } from "../../zod.js";
import { CursorQuerySchema, IdSchema, DateSchema, cursorPage, orNull } from "../../common/index.js";
import { openEnum } from "../../common/open-enum.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { TakedownMethodSchema, TakedownTaskBaseShape } from "../a06-publish/takedown-m6.schemas.js";
import { ChannelAccountBriefSchema } from "./publish.schemas.js";

export const TakedownTaskCardSchema = z
  .object({
    ...TakedownTaskBaseShape,
    orderId: IdSchema,
    posterUrl: orNull(SignedUrlSchema),
    channelAccount: ChannelAccountBriefSchema,
    allowedMethods: z.array(TakedownMethodSchema),
    actions: z.array(openEnum(["confirm"])),
  })
  .openapi("TakedownTaskCard");
export const TakedownTaskWriteResultSchema = TakedownTaskCardSchema.extend({
  replayed: z.boolean(),
}).openapi("TakedownTaskWriteResult");
export const MerchantTakedownTaskSummaryQuerySchema = z.object({ orderId: IdSchema.optional() });
export const MerchantTakedownTaskListQuerySchema = MerchantTakedownTaskSummaryQuerySchema.extend({
  ...CursorQuerySchema.shape,
  tab: z.enum(["pending", "done"]).default("pending"),
});
export const MerchantTakedownTaskPageSchema = cursorPage(TakedownTaskCardSchema).openapi(
  "MerchantTakedownTaskPage",
);
export const MerchantTakedownTaskSummarySchema = z
  .object({
    pending: z.int().nonnegative(),
    done: z.int().nonnegative(),
    overdue: z.int().nonnegative(),
    nextTakedown: z
      .object({
        orderItemId: IdSchema,
        dramaTitle: z.string(),
        usageEndDate: DateSchema,
        createDate: DateSchema,
      })
      .nullable(),
  })
  .openapi("MerchantTakedownTaskSummary");
export const TakedownTaskConfirmBodySchema = z
  .strictObject({ method: TakedownMethodSchema })
  .openapi("TakedownTaskConfirmBody");
export type TakedownTaskCard = z.infer<typeof TakedownTaskCardSchema>;
export type TakedownTaskWriteResult = z.infer<typeof TakedownTaskWriteResultSchema>;
export type MerchantTakedownTaskListQuery = z.infer<typeof MerchantTakedownTaskListQuerySchema>;
export type MerchantTakedownTaskSummaryQuery = z.infer<
  typeof MerchantTakedownTaskSummaryQuerySchema
>;
export type MerchantTakedownTaskSummary = z.infer<typeof MerchantTakedownTaskSummarySchema>;
export type TakedownTaskConfirmBody = z.infer<typeof TakedownTaskConfirmBodySchema>;
