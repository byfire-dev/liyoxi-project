import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
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
