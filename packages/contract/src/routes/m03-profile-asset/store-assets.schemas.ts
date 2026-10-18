import { z } from "../../zod.js";
import {
  CursorQuerySchema,
  DictRefSchema,
  IdSchema,
  InstantSchema,
  orNull,
} from "../../common/index.js";
import {
  MODERATION_STATE,
  STORE_ASSET_TYPE,
  STORE_ASSET_PROCESSING_STATE,
  STORE_ASSET_REVIEW_STATE,
  STORE_ASSET_USABILITY,
  STORE_ASSET_INSIGHT_KIND,
  STORE_ASSET_INSIGHT_STATUS,
  STORE_ASSET_TAG_DIMENSION,
  STORE_ASSET_TAG_SOURCE,
  STORE_ASSET_DEMAND_STATUS,
} from "../../enums/index.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { MediaFileViewSchema } from "./media-file.schemas.js";

export const ASSET_DISPLAY_STATUSES = [
  "organizing",
  "ready",
  "reference_only",
  "need_reshoot",
  "need_portrait_auth",
  "adopted",
] as const;
const count = z.int().nonnegative();
const date = z.iso.date();
const codes = (min: number, max: number) =>
  z
    .array(z.string().min(1).max(100))
    .min(min)
    .max(max)
    .refine((values) => new Set(values).size === values.length, "编码不能重复");
const csv = (values?: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(2200)
    .refine((value) => {
      const parts = value.split(",");
      return (
        parts.every((part) => !!part && (!values || values.includes(part))) &&
        new Set(parts).size === parts.length
      );
    }, "筛选值无效或重复");
const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");
export const AssetTagSchema = z
  .strictObject({
    dimension: z.enum(STORE_ASSET_TAG_DIMENSION.values),
    tag: DictRefSchema,
    source: z.enum(STORE_ASSET_TAG_SOURCE.values),
    isConfirmed: z.boolean(),
    validStartDate: date.nullable(),
    validEndDate: date.nullable(),
  })
  .openapi("AssetTag");
export const UploaderViewSchema = z
  .strictObject({
    actorType: z.enum(["merchant", "staff"]),
    role: z.enum(["owner", "clerk"]).nullable(),
    displayName: z.string().nullable(),
    isMe: z.boolean(),
  })
  .openapi("UploaderView");
export const AssetTranscriptSchema = z.strictObject({
  text: z.string(),
  segments: z.array(
    z
      .strictObject({
        fromMs: count,
        toMs: count,
        text: z.string(),
      })
      .refine((value) => value.fromMs <= value.toMs, "分句时间倒置"),
  ),
});
export const AssetStructuredItemSchema = z.strictObject({
  name: z.string(),
  priceText: z.string().nullable(),
});
export const StoreAssetCardSchema = z
  .strictObject({
    storeAssetId: IdSchema,
    type: z.enum(STORE_ASSET_TYPE.values),
    title: z.string().nullable(),
    displayStatus: z.enum(ASSET_DISPLAY_STATUSES),
    processingState: z.enum(STORE_ASSET_PROCESSING_STATE.values),
    reviewState: z.enum(STORE_ASSET_REVIEW_STATE.values),
    usability: z.enum(STORE_ASSET_USABILITY.values).nullable(),
    adoptedCount: count,
    moderationState: z.enum(MODERATION_STATE.values),
    fileCount: count,
    durationMs: count.nullable(),
    pageCount: count.nullable(),
    thumbnail: orNull(SignedUrlSchema),
    quote: z.string().max(60).nullable(),
    tags: z.array(AssetTagSchema).max(4),
    techSpecLabel: z.string().nullable(),
    structuredItemCount: count.nullable(),
    isSelectableAsReference: z.boolean(),
    uploader: UploaderViewSchema,
    createdAt: InstantSchema,
  })
  .openapi("StoreAssetCard");
export const AssetTimelineEntrySchema = z.strictObject({
  kind: z.enum(["uploaded", "processed", "reviewed", "used_as_reference", "adopted"]),
  at: InstantSchema,
  actorName: z.string().nullable(),
  usedBy: z
    .strictObject({
      type: z.enum(["ad", "drama_order"]),
      id: IdSchema,
      no: z.string(),
    })
    .nullable(),
});
export const StoreAssetDetailSchema = StoreAssetCardSchema.extend({
  textBody: z.string().nullable(),
  note: z.string().nullable(),
  files: z.array(MediaFileViewSchema),
  transcript: AssetTranscriptSchema.nullable(),
  fileTranscripts: z.array(AssetTranscriptSchema.extend({ fileId: IdSchema })),
  highlights: z.array(z.string()),
  structuredItems: z.array(AssetStructuredItemSchema),
  isInsightPartial: z.boolean(),
  tagsByDimension: z.strictObject({
    content: z.array(AssetTagSchema),
    usage: z.array(AssetTagSchema),
    timeliness: z.array(AssetTagSchema),
  }),
  reviewedBy: z.strictObject({ displayName: z.string() }).nullable(),
  reviewedAt: InstantSchema.nullable(),
  portraitAuth: z.strictObject({ fileCount: count, authorizedAt: InstantSchema.nullable() }),
  assetDemand: z.strictObject({ assetDemandId: IdSchema, title: z.string() }).nullable(),
  timeline: z.array(AssetTimelineEntrySchema),
  actions: z.array(z.enum(["portrait-auth", "feedback"])),
}).openapi("StoreAssetDetail");
const assetCounts = {
  image: count,
  video: count,
  recording: count,
  audio: count,
  document: count,
  text: count,
};
export const StoreAssetSummarySchema = z
  .strictObject({
    tabs: z.strictObject({ all: count, ...assetCounts }),
    organizingCount: count,
    adoptedCount: count,
    recent7dCount: count,
    hotTags: z
      .array(
        z.strictObject({
          dimension: z.enum(STORE_ASSET_TAG_DIMENSION.values),
          tag: DictRefSchema,
          assetCount: count,
        }),
      )
      .max(5),
  })
  .openapi("StoreAssetSummary");
export const AssetDemandItemSchema = z
  .strictObject({
    assetDemandId: IdSchema,
    title: z.string(),
    shootingNote: z.string().nullable(),
    dueDate: date,
    status: z.enum(STORE_ASSET_DEMAND_STATUS.values),
    isOverdue: z.boolean(),
    createdByName: z.string(),
    receivedCount: count,
    myUploadCount: count,
    createdAt: InstantSchema,
  })
  .openapi("AssetDemandItem");
export const StoreAssetCreateFields = {
  type: z.enum(STORE_ASSET_TYPE.values),
  fileIds: z.array(IdSchema).min(1).max(9).optional(),
  textBody: z.string().min(1).max(500).optional(),
  contentTagCodes: codes(0, 8).optional(),
  note: z.string().max(200).optional(),
  assetDemandId: IdSchema.optional(),
};
export const validateStoreAssetCreate = (body: {
  type: string;
  fileIds?: readonly string[];
  textBody?: string;
  note?: string;
}) =>
  body.type === "text"
    ? body.textBody !== undefined && body.fileIds === undefined && body.note === undefined
    : body.fileIds !== undefined &&
      body.textBody === undefined &&
      (body.type !== "recording" || body.fileIds.length === 1);
export const StoreAssetCreateBodySchema = z
  .strictObject(StoreAssetCreateFields)
  .refine(validateStoreAssetCreate, "素材类型与文件、正文或说明不符")
  .openapi("StoreAssetCreateBody");
export const PortraitAuthBodySchema = z
  .strictObject({
    fileIds: z
      .array(IdSchema)
      .min(1)
      .max(9)
      .refine((values) => new Set(values).size === values.length, "文件不能重复"),
  })
  .openapi("PortraitAuthBody");
export const AssetFeedbackBodySchema = z
  .strictObject({
    content: z.string().min(1).max(200),
    dimension: z.enum(["content", "usage", "timeliness", "usability"]).optional(),
  })
  .openapi("AssetFeedbackBody");
export const StoreAssetFilterFields = {
  status: csv(ASSET_DISPLAY_STATUSES).optional(),
  tag: csv().optional(),
  q: z.string().min(1).max(30).optional(),
  uploader: z.literal("me").optional(),
  isSelectableAsReference: booleanQuery.optional(),
  assetDemandId: IdSchema.optional(),
};
export const StoreAssetSummaryQuerySchema = z.strictObject(StoreAssetFilterFields);
export const StoreAssetListQuerySchema = z
  .strictObject({
    ...StoreAssetFilterFields,
    ...CursorQuerySchema.shape,
    tab: z.enum(["all", ...STORE_ASSET_TYPE.values]).optional(),
    sort: z.literal("-createdAt").optional(),
    ids: csv()
      .refine((value) => {
        const ids = value.split(",");
        return ids.length <= 20 && ids.every((id) => IdSchema.safeParse(id).success);
      }, "素材ID列表无效")
      .optional(),
  })
  .refine(
    (value) => !value.ids || Object.keys(value).every((key) => ["ids", "limit"].includes(key)),
    "按ID回显不能同时筛选或排序",
  );
export const AssetDemandListQuerySchema = z.strictObject({
  ...CursorQuerySchema.shape,
  status: csv(STORE_ASSET_DEMAND_STATUS.values).optional(),
});
export const AssetPathSchema = z.strictObject({ storeAssetId: IdSchema });
export const AssetDemandPathSchema = z.strictObject({ assetDemandId: IdSchema });
export {
  assetCounts as assetTypeCountFields,
  codes as assetTagCodes,
  csv as assetCsv,
  booleanQuery as assetBooleanQuery,
};
export const AssetInsightStepSchema = z.strictObject({
  kind: z.enum(STORE_ASSET_INSIGHT_KIND.values),
  status: z.enum(STORE_ASSET_INSIGHT_STATUS.values),
});
export type StoreAssetCard = z.infer<typeof StoreAssetCardSchema>;
export type StoreAssetDetail = z.infer<typeof StoreAssetDetailSchema>;
export type StoreAssetCreateBody = z.infer<typeof StoreAssetCreateBodySchema>;
