import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
const n = z.int().nonnegative();
export const OrderItemDownloadParamSchema = z.strictObject({ orderItemId: IdSchema });
export const DownloadUrlSchema = z
  .strictObject({
    url: z.string(),
    expiresAt: InstantSchema,
    fileName: z.string(),
    sizeBytes: z.string().regex(/^\d+$/),
  })
  .openapi("DownloadUrl");
export const EpisodeDownloadBodySchema = z
  .strictObject({ kind: z.literal("episode"), episodeNo: z.int().positive() })
  .openapi("EpisodeDownloadBody");
export const EpisodeDownloadUrlSchema = DownloadUrlSchema.extend({ downloadId: IdSchema }).openapi(
  "EpisodeDownloadUrl",
);
export const ReleaseManifestItemSchema = z
  .strictObject({
    episodeNo: z.int().positive(),
    outputId: IdSchema,
    fileId: IdSchema,
    name: z.string(),
    size: z.string().regex(/^\d+$/),
    crc64: orNull(z.string()),
  })
  .openapi("ReleaseManifestItem");
export const DownloadGrantViewSchema = z
  .strictObject({
    downloadGrantId: IdSchema,
    state: z.enum(["active", "superseded", "revoked"]),
    expiresAt: InstantSchema,
    validDays: z.int().positive(),
    isExpired: z.boolean(),
    createdAt: InstantSchema,
  })
  .openapi("DownloadGrantView");
export const ReleaseViewSchema = z
  .strictObject({
    deliveryReleaseId: IdSchema,
    orderItemId: IdSchema,
    releaseNo: z.int().positive(),
    kind: z.enum(["initial", "reissue"]),
    state: z.enum(["pushed", "superseded", "closed"]),
    closeReason: orNull(z.enum(["cancelled", "usage_ended"])),
    pushedAt: InstantSchema,
    episodeCount: n,
    totalBytes: z.string(),
    changedEpisodeNos: z.array(z.int().positive()),
    episodes: z.array(
      z.strictObject({
        episodeNo: z.int().positive(),
        fileName: z.string(),
        sizeBytes: z.string(),
        isChanged: z.boolean(),
        lastSavedAt: orNull(InstantSchema),
      }),
    ),
    savedEpisodeCount: n,
    grant: orNull(DownloadGrantViewSchema),
    regrantRemainingToday: n,
    isDownloadable: z.boolean(),
    canRegenerate: z.boolean(),
  })
  .openapi("ReleaseView");
export type EpisodeDownloadBody = z.infer<typeof EpisodeDownloadBodySchema>;
