import { z } from "../../zod.js";
import { IdSchema, InstantSchema } from "../../common/index.js";
import { AD_STATUS, AD_VERSION_DECISION, PLACEMENT_SLOT } from "../../enums/index.js";
import { AdPreviewChannelSchema, AdSegmentSchema } from "../m06-ad/ads.schemas.js";

export const PortalAdParamSchema = z.strictObject({ adId: IdSchema });
export const PortalAdListQuerySchema = z
  .strictObject({
    status: z.preprocess(
      (value) => (typeof value === "string" ? value.split(",") : value),
      z.array(z.enum(AD_STATUS.values)).min(1).default(["pending_confirm"]),
    ),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .openapi("PortalAdListQuery");
export const PortalAdPlaybackBodySchema = z
  .strictObject({ versionNo: z.int().positive() })
  .openapi("PortalAdPlaybackBody");
export const PortalAdCardSchema = z
  .strictObject({
    adId: IdSchema,
    adNo: z.string(),
    type: z.enum(PLACEMENT_SLOT.values).extract(["opening", "ending"]),
    durationSec: z.int().positive(),
    status: z.enum(AD_STATUS.values),
    displayStatus: z.enum(["producing", "pending_confirm", "revising", "confirmed", "cancelled"]),
    copy: z.string().nullable(),
    currentVersionNo: z.int().positive(),
    currentVersionPushedAt: InstantSchema,
    currentPreviewChannels: z.array(AdPreviewChannelSchema),
    confirmedVersionNo: z.int().positive().nullable(),
    poster: z.strictObject({ url: z.string(), expiresAt: InstantSchema }).nullable(),
    isPortalPreviewable: z.boolean(),
  })
  .openapi("PortalAdCard");
export const PortalAdVersionViewSchema = z
  .strictObject({
    versionNo: z.int().positive(),
    pushedAt: InstantSchema,
    durationMs: z.int().positive(),
    width: z.int().positive(),
    height: z.int().positive(),
    segments: z.array(AdSegmentSchema),
    previewChannels: z.array(AdPreviewChannelSchema),
    decision: z.enum(AD_VERSION_DECISION.values).nullable(),
    decidedAt: InstantSchema.nullable(),
  })
  .openapi("PortalAdVersionView");
export const PortalAdDetailSchema = PortalAdCardSchema.extend({
  currentVersion: PortalAdVersionViewSchema,
}).openapi("PortalAdDetail");
export const PortalAdPageSchema = z
  .strictObject({
    items: z.array(PortalAdCardSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .openapi("PortalAdPage");
export type PortalAdListQuery = z.infer<typeof PortalAdListQuerySchema>;
export type PortalAdPlaybackBody = z.infer<typeof PortalAdPlaybackBodySchema>;
export type PortalAdCard = z.infer<typeof PortalAdCardSchema>;
export type PortalAdDetail = z.infer<typeof PortalAdDetailSchema>;
