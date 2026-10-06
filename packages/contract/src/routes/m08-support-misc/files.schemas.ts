import { IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";
import {
  FILE_OBJECT_STATUS,
  FILE_OBJECT_REJECT_REASON,
  MODERATION_STATE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
export const MERCHANT_UPLOAD_CATEGORIES = [
  "profile_image",
  "profile_video",
  "profile_promo",
  "kyc_license",
  "kyc_permit",
  "store_asset",
  "portrait_auth",
  "channel_screenshot",
  "ticket_attachment",
  "pay_receipt",
] as const;
export const MerchantUploadCategorySchema = z.enum(MERCHANT_UPLOAD_CATEGORIES);
export const PostPolicySchema = z
  .object({ url: z.string().min(1), fields: z.record(z.string(), z.string()) })
  .openapi("PostPolicy");
export const StsCredentialSchema = z
  .object({
    tmpSecretId: z.string(),
    tmpSecretKey: z.string(),
    sessionToken: z.string(),
    startTime: InstantSchema,
    expiredTime: InstantSchema,
  })
  .openapi("StsCredential");
export const FileRegistrationSchema = z
  .object({
    fileId: IdSchema,
    clientToken: z.string(),
    status: openEnum(FILE_OBJECT_STATUS.values),
    mode: openEnum(["post", "multipart"]),
    bucket: z.string(),
    region: z.string(),
    key: z.string(),
    post: orNull(PostPolicySchema),
    sts: orNull(StsCredentialSchema),
    chunkSize: orNull(z.int().positive()),
    chunkParallel: orNull(z.int().positive()),
    expiresAt: InstantSchema,
    uploadExpiresAt: InstantSchema,
    credentialsLeft: z.int().min(0).max(30),
  })
  .openapi("FileRegistration");
export const FileRegistrationListSchema = z
  .object({ items: z.array(FileRegistrationSchema) })
  .openapi("FileRegistrationList");
export const FileStatusViewSchema = z
  .object({
    fileId: IdSchema,
    category: openEnum(MERCHANT_UPLOAD_CATEGORIES),
    status: openEnum(FILE_OBJECT_STATUS.values),
    rejectReason: orNull(openEnum(FILE_OBJECT_REJECT_REASON.values)),
    declaredSizeBytes: z.string().regex(/^[0-9]+$/),
    sizeBytes: orNull(z.string().regex(/^[0-9]+$/)),
    mime: orNull(z.string()),
    moderationState: openEnum(MODERATION_STATE.values),
    storedAt: orNull(InstantSchema),
    uploadExpiresAt: orNull(InstantSchema),
    createdAt: InstantSchema,
  })
  .openapi("FileStatusView");
export const UploadFileBodySchema = z
  .object({
    fileName: z.string().min(1).max(200),
    sizeBytes: z.string().regex(/^[1-9][0-9]*$/),
    clientToken: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();
export const MerchantFileCreateBodySchema = z
  .object({
    category: MerchantUploadCategorySchema,
    licenseKind: z.enum(["business_license", "branch_license"]).optional(),
    files: z.array(UploadFileBodySchema).min(1).max(9),
  })
  .strict()
  .openapi("MerchantFileCreateBody");
export const FileIdParamsSchema = z.object({ fileId: IdSchema });
export type FileRegistration = z.infer<typeof FileRegistrationSchema>;
export type FileStatusView = z.infer<typeof FileStatusViewSchema>;
