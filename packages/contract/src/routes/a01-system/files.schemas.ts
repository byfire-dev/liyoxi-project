import {
  DateSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
  orNull,
} from "../../common/index.js";
import {
  FILE_OBJECT_CATEGORY,
  FILE_OBJECT_SCOPE_TYPE,
  FILE_OBJECT_STATUS,
  MEDIA_ACTOR_TYPE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { FileStatusViewSchema, UploadFileBodySchema } from "../m08-support-misc/files.schemas.js";
import { adminPage } from "./structures.js";
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

const csv = (values: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => value.split(",").every((one) => values.includes(one)), "查询值未登记")
    .transform((value) => [...new Set(value.split(","))]);
export const AdminFileListQuerySchema = PageQuerySchema.extend({
  status: csv(FILE_OBJECT_STATUS.values).optional(),
  category: csv(FILE_OBJECT_CATEGORY.values).optional(),
  scopeType: z.enum(FILE_OBJECT_SCOPE_TYPE.values).optional(),
  entityId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  uploadActorType: z.enum(MEDIA_ACTOR_TYPE.values).optional(),
  uploadActorId: IdSchema.optional(),
  purgeRunId: IdSchema.optional(),
  fileIds: z
    .string()
    .min(1)
    .max(4000)
    .transform((value) => [...new Set(value.split(","))])
    .pipe(z.array(IdSchema).max(100))
    .optional(),
  q: z.string().trim().max(200).optional(),
  deletedFrom: DateSchema.optional(),
  deletedTo: DateSchema.optional(),
  sort: z.enum(["-deletedAt", "-createdAt", "-sizeBytes"]).default("-deletedAt"),
})
  .superRefine((value, ctx) => {
    if (value.deletedFrom && value.deletedTo && value.deletedFrom > value.deletedTo)
      ctx.addIssue({ code: "custom", path: ["deletedTo"], message: "日期范围倒置" });
  })
  .openapi("AdminFileListQuery");
export type AdminFileListQuery = z.infer<typeof AdminFileListQuerySchema>;
export const AdminFilePageSchema = adminPage(AdminFileViewSchema).openapi("AdminFilePage");
const reason = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine(
      (value) => [...value].length >= min && [...value].length <= max,
      `原因须为${min}至${max}字`,
    )
    .openapi({ minLength: min, maxLength: max });
export const ReasonRequiredBodySchema = z
  .strictObject({ reason: reason(5, 200) })
  .openapi("ReasonRequiredBody");
export const FileRestoreBodySchema = ReasonRequiredBodySchema;
export type FileRestoreBody = z.infer<typeof FileRestoreBodySchema>;
export const FileEraseBodySchema = z
  .strictObject({
    reason: reason(10, 500),
    confirm: z.strictObject({ fileId: IdSchema, category: z.enum(FILE_OBJECT_CATEGORY.values) }),
  })
  .openapi("FileEraseBody");
export type FileEraseBody = z.infer<typeof FileEraseBodySchema>;
