import { z } from "../../zod.js";
import { DateSchema, IdSchema } from "../../common/index.js";
export const M05_ERROR_DETAILS = {
  DOWNLOAD_GRANT_INVALID: z.strictObject({
    reason: z.enum(["expired", "superseded", "revoked", "missing"]),
    expiresAt: z.string().datetime().nullable(),
    canRegenerate: z.boolean(),
  }),
  DOWNLOAD_NOT_AVAILABLE: z.strictObject({
    reason: z.enum([
      "not_delivered",
      "release_closed",
      "order_item_closed",
      "usage_ended",
      "file_unavailable",
    ]),
  }),
  SAMPLE_VERSION_STALE: z.object({
    currentSampleId: IdSchema.nullable(),
    currentVersionNo: z.int().nullable(),
  }),
  SAMPLE_VIEW_CHANNEL_NOT_OFFERED: z.object({
    previewChannels: z.array(z.enum(["weapp", "album", "portal", "wecom"])),
  }),
  SAMPLE_NOT_VIEWABLE: z.object({
    viewedVia: z.enum(["weapp", "album", "portal", "wecom"]),
    requiredEvidence: z.enum(["album_saved", "portal_viewed", "wecom_sent", "album_or_portal"]),
  }),
  AD_CHANGED: z.object({ adIds: z.array(IdSchema) }),
  ORDER_IN_AFTER_SALE: z.object({ cancelRequestId: IdSchema }),
  PLAN_VERSION_STALE: z.object({ currentVersionNo: z.int().nonnegative() }),
  TICKET_ON_HOLD: z.object({ reasons: z.array(z.enum(["cancel_review", "plan_amendment"])) }),
  LINK_INVALID: z.object({
    field: z.string(),
    reason: z.enum([
      "unparsable",
      "not_https",
      "too_long",
      "has_credentials",
      "duplicate_episode",
      "episode_out_of_range",
    ]),
  }),
  LAUNCH_SUBMISSION_OUT_OF_RANGE: z.union([
    z.object({ field: z.literal("actualLaunchDate"), min: DateSchema, max: DateSchema, IdSchema }),
    z.object({ field: z.literal("reportedEpisodeCount"), min: z.int(), max: z.int() }),
  ]),
  LAUNCH_WINDOW_CLOSED: z.object({ usageEndDate: DateSchema, IdSchema }),
};
