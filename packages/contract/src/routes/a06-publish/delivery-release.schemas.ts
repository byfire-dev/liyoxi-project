import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
import { ZIP_BUNDLE_ZIP_STATE } from "../../enums/index.js";
import { ReleaseAdminViewSchema } from "../a05-order-delivery/production.schemas.js";
import { AdminStoreBriefSchema } from "../a05-order-delivery/public.schemas.js";
import { ReleaseManifestItemSchema } from "../m05-delivery-publish/download.schemas.js";
import { TicketBriefSchema, OrderItemBriefSchema } from "./publish.schemas.js";
export const DeliveryReleaseParamSchema = z.strictObject({ deliveryReleaseId: IdSchema });
export const DeliveryReleaseDetailSchema = ReleaseAdminViewSchema.extend({
  ticket: TicketBriefSchema,
  orderItem: OrderItemBriefSchema,
  store: AdminStoreBriefSchema,
  manifest: z.array(ReleaseManifestItemSchema),
  publishListText: orNull(z.string()),
  activeGrant: orNull(z.strictObject({ downloadGrantId: IdSchema, expiresAt: InstantSchema })),
  actions: z.array(z.string()),
}).openapi("DeliveryReleaseDetail");

export const DeliveryReleasePackResultSchema = z
  .strictObject({
    deliveryReleaseId: IdSchema,
    zipBundleId: IdSchema,
    zipState: z.enum(ZIP_BUNDLE_ZIP_STATE.values),
    zipGen: z.int().positive(),
    zipFileId: orNull(IdSchema),
    publishListFileId: orNull(IdSchema),
  })
  .superRefine((value, ctx) => {
    if (value.zipState === "ready" && value.zipFileId === null) {
      ctx.addIssue({ code: "custom", path: ["zipFileId"], message: "就绪包必须有ZIP文件" });
    }
    if (
      value.zipState !== "ready" &&
      (value.zipFileId !== null || value.publishListFileId !== null)
    ) {
      ctx.addIssue({ code: "custom", path: ["zipState"], message: "未就绪包不能提供缓存文件" });
    }
  })
  .openapi("DeliveryReleasePackResult");
