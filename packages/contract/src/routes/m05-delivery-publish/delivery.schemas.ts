import { z } from "../../zod.js";
import { IdSchema, DateSchema, InstantSchema, DictRefSchema, orNull } from "../../common/index.js";
import { DELIVERY_PLAN_STATUS, DELIVERY_PLAN_VERSION_DECISION } from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import {
  PlanChangeKindsSchema,
  PlanChangeRequestViewSchema,
} from "../a05-order-delivery/delivery.schemas.js";
import { ChannelAccountBriefSchema } from "./publish.schemas.js";
const n = z.int().min(0),
  text = z.string(),
  at = orNull(InstantSchema);
export const PlanConfirmBodySchema = z.strictObject({ versionNo: z.int().min(1) });
export const PlanChangeRequestBodySchema = z.strictObject({
  kinds: z
    .array(PlanChangeKindsSchema)
    .min(1)
    .max(6)
    .refine((a) => new Set(a).size === a.length),
  note: text.trim().min(1).max(200),
});
export const PlanPlacementViewSchema = z.strictObject({
  slot: z.enum(["opening", "ending"]),
  durationSec: n,
  adId: IdSchema,
  adNo: text,
  adDisplayStatus: z.enum(["producing", "pending_confirm", "revising", "confirmed", "cancelled"]),
  adCopy: orNull(text),
  latestVersionNo: n,
  nextVersionNo: orNull(n),
  openRevisionRequestedAt: at,
  confirmedVersionNo: orNull(n),
  confirmedAt: at,
  dueAt: at,
});
export const PlanContentViewSchema = z
  .strictObject({
    focusTags: z.array(text),
    referenceAssets: z.array(
      z.strictObject({
        storeAssetId: IdSchema,
        type: text,
        title: orNull(text),
        contentTags: z.array(DictRefSchema),
      }),
    ),
    profileMedia: z.array(
      z.strictObject({
        fileId: IdSchema,
        mediaGroup: z.enum(["door", "interior", "product", "promo"]),
        type: z.enum(["image", "video"]),
      }),
    ),
    note: orNull(text),
    launchMode: z.literal("merchant_self"),
    items: z.array(
      z.strictObject({
        orderItemId: IdSchema,
        dramaTitle: text,
        genres: z.array(DictRefSchema),
        posterUrl: orNull(SignedUrlSchema),
        episodeCount: n,
        usageEndDate: DateSchema,
        productionModel: z.enum(["standard", "advanced", "top"]),
        accounts: z.array(ChannelAccountBriefSchema),
        placements: z.array(PlanPlacementViewSchema),
        agreedLaunchDate: DateSchema,
        expectedDeliveryDate: orNull(DateSchema),
      }),
    ),
  })
  .openapi("PlanContentView");
export const DeliveryPlanDetailSchema = z
  .strictObject({
    deliveryPlanId: IdSchema,
    orderId: IdSchema,
    orderNo: text,
    planCode: text,
    status: zodEnum(DELIVERY_PLAN_STATUS),
    currentVersionNo: n,
    confirmedVersionNo: orNull(n),
    confirmedAt: at,
    staffDueAt: at,
    isOrderInAfterSale: z.boolean(),
    deliveryManagerName: orNull(text),
    version: orNull(
      z.strictObject({
        versionNo: n,
        pushedAt: InstantSchema,
        pushedByName: text,
        changeSummary: orNull(text),
        decision: orNull(zodEnum(DELIVERY_PLAN_VERSION_DECISION)),
        decidedAt: at,
      }),
    ),
    content: orNull(PlanContentViewSchema),
    itemCount: n,
    totalEpisodes: n,
    openChange: orNull(
      z.strictObject({ kinds: z.array(PlanChangeKindsSchema), notes: z.array(text) }),
    ),
    changeRequests: z.array(PlanChangeRequestViewSchema),
    actions: z.array(text),
  })
  .openapi("DeliveryPlanDetail");
export const DeliveryPlanWriteResultSchema = DeliveryPlanDetailSchema.extend({
  replayed: z.boolean(),
});
export type PlanConfirmBody = z.infer<typeof PlanConfirmBodySchema>;
export type PlanChangeRequestBody = z.infer<typeof PlanChangeRequestBodySchema>;
