import { IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";
import {
  FILE_OBJECT_CATEGORY,
  FILE_OBJECT_SCOPE_TYPE,
  MEDIA_ACTOR_TYPE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { FileStatusViewSchema, UploadFileBodySchema } from "../m08-support-misc/files.schemas.js";
export const SignedUrlSchema = z
  .object({ url: z.string().min(1), expiresAt: InstantSchema })
  .strict()
  .openapi("SignedUrl");
export const AdminFileViewSchema = FileStatusViewSchema.omit({
  createdAt: true,
  uploadExpiresAt: true,
})
  .extend({
    category: openEnum(FILE_OBJECT_CATEGORY.values),
    scopeType: openEnum(FILE_OBJECT_SCOPE_TYPE.values),
    entityId: orNull(IdSchema),
    storeId: orNull(IdSchema),
    originalName: orNull(z.string()),
    ext: z.string(),
    uploader: z.object({
      actorType: openEnum(MEDIA_ACTOR_TYPE.values),
      actorId: orNull(IdSchema),
      client: orNull(openEnum(["weapp", "portal", "admin"])),
      label: z.string(),
    }),
    onBehalfStoreId: orNull(IdSchema),
    purgeAfter: orNull(InstantSchema),
    deletedAt: orNull(InstantSchema),
    erasedAt: orNull(InstantSchema),
    restorableUntil: orNull(InstantSchema),
    liveRefCount: z.int().nonnegative(),
    production: z.null(),
    check: z.null(),
    actions: z.array(openEnum(["restore", "erase", "cancel"])),
  })
  .openapi("AdminFileView");
const ProductionContextSchema = z
  .object({
    kind: z.enum(["sample", "final", "ad"]),
    orderItemId: IdSchema.optional(),
    adId: IdSchema.optional(),
    episodeNo: z.int().positive().optional(),
    dramaEpisodeMasterId: IdSchema.optional(),
    aiUsage: z.object({
      used: z.boolean(),
      tools: z.array(z.object({ name: z.string(), version: z.string(), usedFor: z.string() })),
    }),
  })
  .strict();
export const AdminFileCreateBodySchema = UploadFileBodySchema.extend({
  category: z.enum(FILE_OBJECT_CATEGORY.values),
  mime: z.string().optional(),
  storeId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  onBehalfStore: z.boolean().optional(),
  production: ProductionContextSchema.optional(),
})
  .strict()
  .openapi("AdminFileCreateBody");
export const FileDownloadUrlsBodySchema = z
  .object({
    disposition: z.enum(["inline", "attachment"]).default("inline"),
    purpose: z.string().max(50).optional(),
  })
  .strict()
  .openapi("FileDownloadUrlsBody");
export type SignedUrl = z.infer<typeof SignedUrlSchema>;
export type AdminFileView = z.infer<typeof AdminFileViewSchema>;
