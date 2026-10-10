import { z } from "../../zod.js";
import { DictRefSchema, IdSchema, InstantSchema, PageQuerySchema } from "../../common/index.js";
import {
  STORE_ASSET_TYPE,
  STORE_ASSET_USABILITY,
  STORE_ASSET_INSIGHT_KIND,
  STORE_ASSET_DEMAND_NOTIFY_SCOPE,
} from "../../enums/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import {
  AssetTagSchema,
  AssetInsightStepSchema,
  AssetTranscriptSchema,
  AssetStructuredItemSchema,
  AssetDemandItemSchema,
  StoreAssetCardSchema,
  StoreAssetCreateFields,
  validateStoreAssetCreate,
  assetTypeCountFields,
  assetTagCodes,
  assetCsv,
  assetBooleanQuery,
} from "../m03-profile-asset/store-assets.schemas.js";
import { MediaFileViewSchema } from "../m03-profile-asset/media-file.schemas.js";
const count = z.int().nonnegative();
const portrait = z.strictObject({ fileCount: count, authorizedAt: InstantSchema.nullable() });
export const AdminStoreAssetRowSchema = StoreAssetCardSchema.pick({
  storeAssetId: true,
  type: true,
  title: true,
  fileCount: true,
  durationMs: true,
  pageCount: true,
  thumbnail: true,
  usability: true,
  processingState: true,
  moderationState: true,
  adoptedCount: true,
  createdAt: true,
})
  .extend({
    storeId: IdSchema,
    storeName: z.string().nullable(),
    charCount: count.nullable(),
    uploader: z.strictObject({
      actorType: z.enum(["merchant", "staff"]),
      role: z.enum(["owner", "clerk"]).nullable(),
      displayName: z.string().nullable(),
      merchantUserId: IdSchema.nullable(),
      staffId: IdSchema.nullable(),
    }),
    contentTags: z.array(AssetTagSchema),
    hasUnconfirmedAutoTags: z.boolean(),
    usageTags: z.array(AssetTagSchema),
    timelinessTag: AssetTagSchema.nullable(),
    adminStatus: z.enum(["organizing", "organized", "adopted"]),
    isInsightPartial: z.boolean(),
    portraitAuth: portrait,
    reviewDueAt: InstantSchema.nullable(),
    isReviewOverdue: z.boolean(),
    assetDemandId: IdSchema.nullable(),
    sourceStoreAssetId: IdSchema.nullable(),
    actions: z.array(
      z.enum(["review", "confirm-portrait-auth", "portrait-auth", "reprocess", "delete"]),
    ),
  })
  .openapi("AdminStoreAssetRow");
export const AdminStoreAssetDetailSchema = AdminStoreAssetRowSchema.extend({
  textBody: z.string().nullable(),
  note: z.string().nullable(),
  files: z.array(MediaFileViewSchema),
  transcript: AssetTranscriptSchema.nullable(),
  keypoints: z.array(z.string()),
  structuredItems: z.array(AssetStructuredItemSchema),
  techSpecLabel: z.string().nullable(),
  suggestion: z
    .strictObject({
      contentTags: z.array(DictRefSchema),
      usageTags: z.array(DictRefSchema),
      timeliness: z
        .strictObject({
          tag: DictRefSchema,
          validStartDate: z.iso.date().nullable(),
          validEndDate: z.iso.date().nullable(),
        })
        .nullable(),
      faceHint: z.enum(["none", "people_unclear", "identifiable_customer"]),
      qualityNotes: z.array(z.string()),
      description: z.string().nullable(),
    })
    .nullable(),
  insightSteps: z.array(AssetInsightStepSchema),
  portraitAuthFileIds: z.array(IdSchema),
  reviewedBy: StaffBriefSchema.nullable(),
  reviewedAt: InstantSchema.nullable(),
  usages: z.array(
    z.strictObject({
      usedByType: z.enum(["ad", "drama_order", "order_item", "ad_version", "episode_output"]),
      usedById: IdSchema,
      usedByNo: z.string(),
      role: z.enum(["reference", "adopted"]),
      at: InstantSchema,
    }),
  ),
  lockVersion: count,
}).openapi("AdminStoreAssetDetail");
export const AdminStoreAssetSummarySchema = z
  .strictObject({
    tabs: z.strictObject({ all: count, organizing: count, adopted: count }),
    organizedCount: count,
    types: z.strictObject(assetTypeCountFields),
    awaitingPortraitConfirmCount: count,
    reviewOverdueCount: count,
  })
  .openapi("AdminStoreAssetSummary");
export const AdminAssetDemandRowSchema = AssetDemandItemSchema.omit({
  createdByName: true,
  myUploadCount: true,
})
  .extend({
    storeId: IdSchema,
    notifyScope: z.enum(STORE_ASSET_DEMAND_NOTIFY_SCOPE.values),
    createdBy: StaffBriefSchema,
    closedAt: InstantSchema.nullable(),
    actions: z.array(z.enum(["complete", "cancel"])),
  })
  .openapi("AssetDemandRow");
export const AdminStoreAssetCreateBodySchema = z
  .strictObject({ ...StoreAssetCreateFields, storeId: IdSchema })
  .refine(validateStoreAssetCreate, "素材类型与文件或正文不符");
const filters = {
  storeId: IdSchema.optional(),
  type: assetCsv(STORE_ASSET_TYPE.values).optional(),
  usability: assetCsv(STORE_ASSET_USABILITY.values).optional(),
  hasPortraitAuthFiles: assetBooleanQuery.optional(),
  assetDemandId: IdSchema.optional(),
  q: z.string().min(1).max(30).optional(),
};
export const AdminStoreAssetListQuerySchema = z
  .strictObject({
    ...filters,
    ...PageQuerySchema.shape,
    tab: z.enum(["all", "organizing", "adopted"]).optional(),
    sort: z.enum(["-createdAt", "reviewDueAt"]).optional(),
  })
  .refine(
    (value) => !!value.storeId || (value.tab === "organizing" && !value.assetDemandId),
    "跨门店只允许待整理队列",
  );
export const AdminStoreAssetSummaryQuerySchema = z
  .strictObject(filters)
  .refine((value) => !!value.storeId || !value.assetDemandId, "需求筛选必须带门店");
export const AdminStoreAssetReviewBodySchema = z.strictObject({
  lockVersion: count,
  title: z.string().max(60).nullable().optional(),
  contentTagCodes: assetTagCodes(1, 8),
  usageTagCodes: assetTagCodes(1, 5),
  timeliness: z
    .strictObject({
      tagCode: z.string().min(1),
      validStartDate: z.iso.date().optional(),
      validEndDate: z.iso.date().optional(),
    })
    .refine(
      (value) =>
        (!value.validStartDate && !value.validEndDate) ||
        (!!value.validStartDate &&
          !!value.validEndDate &&
          value.validStartDate <= value.validEndDate),
      "时效区间不合法",
    ),
  usability: z.enum(STORE_ASSET_USABILITY.values),
});
export const AdminStoreAssetConfirmPortraitBodySchema = z.strictObject({
  lockVersion: count,
  usability: z.enum(["ready", "reference_only"]),
  note: z.string().max(200).optional(),
});
export const AdminStoreAssetDeleteBodySchema = z.strictObject({
  reasonText: z.string().min(1).max(200),
});
export const AdminStoreAssetReprocessBodySchema = z.strictObject({
  kinds: z
    .array(z.enum(STORE_ASSET_INSIGHT_KIND.values))
    .min(1)
    .max(6)
    .refine((value) => new Set(value).size === value.length, "步骤不能重复")
    .optional(),
});
export const AdminAssetDemandCreateBodySchema = z.strictObject({
  storeId: IdSchema,
  title: z.string().min(1).max(20),
  shootingNote: z.string().max(200).optional(),
  dueDate: z.iso.date(),
  notifyScope: z.enum(STORE_ASSET_DEMAND_NOTIFY_SCOPE.values),
});
export const AdminAssetDemandListQuerySchema = z.strictObject({
  ...PageQuerySchema.shape,
  storeId: IdSchema,
  status: assetCsv(["open", "done", "canceled"]).optional(),
});
export const AdminAssetDemandCancelBodySchema = z.strictObject({
  reasonText: z.string().max(200).optional(),
});
export type AdminStoreAssetRow = z.infer<typeof AdminStoreAssetRowSchema>;
export type AdminStoreAssetDetail = z.infer<typeof AdminStoreAssetDetailSchema>;
