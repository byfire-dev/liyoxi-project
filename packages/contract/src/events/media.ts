import { IdSchema } from "../common/index.js";
import { z } from "../zod.js";
const fileFact = z.object({ v: z.literal(1), fileId: IdSchema }).strict();
export const payloads = {
  "asset.adopted": z.strictObject({
    v: z.literal(1),
    storeAssetId: IdSchema,
    storeId: IdSchema,
    usedByType: z.enum(["ad_version", "order_item"]),
    usedById: IdSchema,
    uploaderUserId: IdSchema.optional(),
  }),
  "file.uploaded": fileFact,
  "file.stored": fileFact,
  "file.rejected": fileFact,
  "media.production.checked": z.strictObject({
    v: z.literal(1),
    fileId: IdSchema,
    kind: z.enum(["sample", "final", "ad"]),
    orderItemId: IdSchema.optional(),
    gate: z.enum(["pass", "reject"]),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  "media.production.derived": z.strictObject({
    v: z.literal(1),
    fileId: IdSchema,
    sourceFileId: IdSchema,
    derivation: z.enum(["normalize", "restamp"]),
  }),
  "media.playable.ready": z.strictObject({
    v: z.literal(1),
    playableAssetId: IdSchema,
    ownerType: z.string().min(1).max(64),
    ownerId: IdSchema,
    kind: z.enum(["trailer", "sample", "ad"]),
  }),
  "media.playable.failed": z.strictObject({
    v: z.literal(1),
    playableAssetId: IdSchema,
    ownerType: z.string().min(1).max(64),
    ownerId: IdSchema,
    kind: z.enum(["trailer", "sample", "ad"]),
  }),
  "drama.trailer_ready": z.strictObject({
    v: z.literal(1),
    dramaId: IdSchema,
    playableAssetId: IdSchema,
  }),
} as const;
