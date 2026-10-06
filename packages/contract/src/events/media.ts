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
} as const;
