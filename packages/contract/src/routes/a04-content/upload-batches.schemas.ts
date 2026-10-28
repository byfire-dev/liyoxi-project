import { z } from "../../zod.js";
import { IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";
import {
  FILE_OBJECT_STATUS,
  FILE_OBJECT_REJECT_REASON,
  MASTER_REPLACE_REASON,
  UPLOAD_BATCH_PURPOSE,
  UPLOAD_BATCH_SCOPE,
  UPLOAD_BATCH_STATE,
  UPLOAD_BATCH_ITEM_STATE,
  UPLOAD_BATCH_ITEM_MATCH_METHOD,
  MEDIA_CHECK_GATE,
} from "../../enums/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { StsCredentialSchema } from "../m08-support-misc/files.schemas.js";

const AiToolSchema = z
  .object({ name: z.string(), version: z.string(), usedFor: z.string() })
  .strict();
export const BatchAiDeclarationSchema = z
  .object({ used: z.boolean(), tools: z.array(AiToolSchema) })
  .strict();
export const BatchAiUsageSchema = BatchAiDeclarationSchema.extend({
  declaredBy: IdSchema,
  declaredAt: InstantSchema,
  forcedByDrama: z.boolean(),
}).openapi("AiUsage");

export const BatchFileDraftSchema = z
  .object({
    clientToken: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    originalName: z.string().min(1).max(255),
    sizeBytes: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();

export const UploadBatchCreateBodySchema = z
  .object({
    purpose: z.enum(UPLOAD_BATCH_PURPOSE.values),
    targetId: IdSchema,
    scope: z.enum(UPLOAD_BATCH_SCOPE.values),
    replaceReason: z.enum(MASTER_REPLACE_REASON.values).nullable().optional(),
    isContentChanged: z.boolean().default(false),
    note: z.string().max(200).nullable().optional(),
    aiUsage: BatchAiDeclarationSchema.nullable().optional(),
    files: z.array(BatchFileDraftSchema).min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.purpose === "final_release") {
      if (!body.aiUsage)
        ctx.addIssue({
          code: "custom",
          path: ["aiUsage"],
          message: "A final batch needs an AI declaration",
        });
      if (body.replaceReason != null)
        ctx.addIssue({
          code: "custom",
          path: ["replaceReason"],
          message: "A final batch has no master replacement reason",
        });
      if (body.isContentChanged)
        ctx.addIssue({
          code: "custom",
          path: ["isContentChanged"],
          message: "Content changes apply to masters",
        });
    } else if (body.aiUsage != null) {
      ctx.addIssue({
        code: "custom",
        path: ["aiUsage"],
        message: "A master batch has no AI declaration",
      });
    }
  })
  .openapi("UploadBatchCreateBody");

export const UploadBatchStartBodySchema = z
  .object({
    acceptSequenceSuggestion: z.boolean().default(false),
  })
  .strict();
export const UploadBatchEmptyBodySchema = z.object({}).strict();
export const UploadBatchItemUpdateBodySchema = z
  .union([
    z.object({ episodeNo: z.int().positive().nullable() }).strict(),
    z.object({ skip: z.literal(true) }).strict(),
    z.object({ replacementFile: BatchFileDraftSchema }).strict(),
  ])
  .openapi("UploadBatchItemUpdateBody");
export const UploadBatchParamsSchema = z.object({ uploadBatchId: IdSchema });
export const UploadBatchItemParamsSchema = z.object({ uploadBatchItemId: IdSchema });

export const UploadBatchCoverageSchema = z
  .object({
    missingEpisodeNos: z.array(z.int().positive()),
    duplicateEpisodeNos: z.array(z.int().positive()),
    unmatchedItemIds: z.array(IdSchema),
    needsSequenceConfirm: z.boolean(),
  })
  .openapi("UploadBatchCoverage");

const ActualSchema = z.union([z.string(), z.number()]);
export const UploadBatchItemSchema = z
  .object({
    uploadBatchItemId: IdSchema,
    fileId: IdSchema,
    originalName: z.string(),
    sizeBytes: z.string().regex(/^[0-9]+$/),
    uploadKey: orNull(z.string()),
    fileStatus: openEnum(FILE_OBJECT_STATUS.values),
    rejectReason: orNull(openEnum(FILE_OBJECT_REJECT_REASON.values)),
    episodeNo: orNull(z.int().positive()),
    episodeTitle: orNull(z.string()),
    matchMethod: orNull(openEnum(UPLOAD_BATCH_ITEM_MATCH_METHOD.values)),
    state: openEnum(UPLOAD_BATCH_ITEM_STATE.values),
    durationMs: orNull(z.int().nonnegative()),
    previousDurationMs: orNull(z.int().nonnegative()),
    isDurationDiffWarn: z.boolean(),
    check: orNull(
      z.object({
        gate: openEnum(MEDIA_CHECK_GATE.values),
        failedHard: z.array(
          z.object({ code: z.string(), actual: ActualSchema, expected: ActualSchema }),
        ),
        warnings: z.array(z.object({ code: z.string(), note: z.string() })),
      }),
    ),
    aiUsage: orNull(BatchAiUsageSchema),
    updatedAt: InstantSchema,
  })
  .openapi("UploadBatchItem");

export const UploadBatchDetailSchema = z
  .object({
    uploadBatchId: IdSchema,
    purpose: openEnum(UPLOAD_BATCH_PURPOSE.values),
    targetId: IdSchema,
    targetLabel: z.string(),
    variant: openEnum(["common"]),
    scope: openEnum(UPLOAD_BATCH_SCOPE.values),
    state: openEnum(UPLOAD_BATCH_STATE.values),
    expectedCount: z.int().positive(),
    replaceReason: orNull(openEnum(MASTER_REPLACE_REASON.values)),
    isContentChanged: z.boolean(),
    aiUsage: orNull(BatchAiUsageSchema),
    note: orNull(z.string()),
    bucket: z.string(),
    region: z.string(),
    prefix: z.string(),
    expiresAt: InstantSchema,
    committedAt: orNull(InstantSchema),
    createdBy: StaffBriefSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    counts: z.object({
      total: z.int().nonnegative(),
      pending: z.int().nonnegative(),
      uploaded: z.int().nonnegative(),
      checked: z.int().nonnegative(),
      rejected: z.int().nonnegative(),
      skipped: z.int().nonnegative(),
      replaced: z.int().nonnegative(),
    }),
    coverage: UploadBatchCoverageSchema,
    items: z.array(UploadBatchItemSchema),
    actions: z.array(openEnum(["start", "refresh-credentials", "commit", "cancel"])),
  })
  .openapi("UploadBatchDetail");

const BatchMultipartCredentialsSchema = z.object({
  mode: z.literal("multipart").optional(),
  bucket: z.string(),
  region: z.string(),
  prefix: z.string(),
  sts: StsCredentialSchema,
  chunkSize: z.int().positive(),
  fileParallel: z.int().positive(),
  chunkParallel: z.int().positive(),
  expiresAt: InstantSchema,
});
const BatchPostCredentialsSchema = z
  .object({
    mode: z.literal("post"),
    bucket: z.string(),
    region: z.string(),
    prefix: z.string(),
    fileParallel: z.int().positive(),
    expiresAt: InstantSchema,
    posts: z
      .array(
        z
          .object({
            fileId: IdSchema,
            key: z.string(),
            post: z.object({ url: z.url(), fields: z.record(z.string(), z.string()) }).strict(),
            expiresAt: InstantSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const BatchUploadCredentialsSchema = z
  .union([BatchMultipartCredentialsSchema, BatchPostCredentialsSchema])
  .openapi("BatchUploadCredentials");
export const UploadBatchCommitResultSchema = z
  .object({
    batch: UploadBatchDetailSchema,
    masters: z.array(
      z.object({
        episodeNo: z.int().positive(),
        dramaEpisodeMasterId: IdSchema,
        revNo: z.int().positive(),
      }),
    ),
  })
  .openapi("UploadBatchCommitResult");

export type UploadBatchDetail = z.infer<typeof UploadBatchDetailSchema>;
export type UploadBatchItemView = z.infer<typeof UploadBatchItemSchema>;
export type UploadBatchCreateBody = z.infer<typeof UploadBatchCreateBodySchema>;
export type UploadBatchItemUpdateBody = z.infer<typeof UploadBatchItemUpdateBodySchema>;
export type BatchAiUsage = z.infer<typeof BatchAiUsageSchema>;
export type BatchUploadCredentials = z.infer<typeof BatchUploadCredentialsSchema>;
export type UploadBatchCoverage = z.infer<typeof UploadBatchCoverageSchema>;
