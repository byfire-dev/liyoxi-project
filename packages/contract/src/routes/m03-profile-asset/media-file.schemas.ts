import { z } from "../../zod.js";
import { IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";

/** Shared profile/asset file projection. Keeping this leaf independent avoids a schema cycle. */
export const MediaFileViewSchema = z
  .object({
    fileId: IdSchema,
    kind: openEnum(["image", "video", "audio", "document"]),
    url: z.string().nullable(),
    expiresAt: orNull(InstantSchema),
    coverUrl: z.string().nullable(),
    durationMs: z.int().nullable(),
    displayWidth: z.int().nullable(),
    displayHeight: z.int().nullable(),
    moderationState: openEnum(["none", "pending", "pass", "review", "block"]),
  })
  .openapi("MediaFileView");
