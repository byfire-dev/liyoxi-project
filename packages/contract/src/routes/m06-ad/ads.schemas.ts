import { z } from "../../zod.js";
import { IdSchema, InstantSchema, DictRefSchema, openEnum } from "../../common/index.js";
import {
  AD_STATUS,
  AD_VERSION_DECISION,
  AD_REVISION_SOURCE,
  PLACEMENT_SLOT,
  ACTOR_TYPE,
  SAMPLE_CONFIRM_VIEWED_VIA,
} from "../../enums/index.js";
import { QuoteBlockerSchema } from "../m04-mall-order/order.schemas.js";
import { ImageRefSchema } from "../m08-support-misc/image.schemas.js";
import { PlayableSchema } from "./playable.schemas.js";
const n = z.int().nonnegative(),
  positive = z.int().positive();
const chars = (max: number) => z.string().refine((v) => [...v].length <= max, `最多 ${max} 字`);
const ids = (max: number) =>
  z
    .array(IdSchema)
    .max(max)
    .refine((v) => new Set(v).size === v.length);
const slot = z.enum(PLACEMENT_SLOT.values).extract(["opening", "ending"]);
export const AdPreviewChannelSchema = z.enum(SAMPLE_CONFIRM_VIEWED_VIA.values);
const previewView = openEnum(SAMPLE_CONFIRM_VIEWED_VIA.values);
export const AdParamSchema = z.strictObject({ adId: IdSchema });
export const AdQuoteBodySchema = z.strictObject({
  type: slot.optional(),
  durationSec: positive.optional(),
});
export const AdCreateBodySchema = z.strictObject({
  type: slot,
  durationSec: positive,
  promoPointCodes: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .refine((v) => new Set(v).size === v.length),
  copy: chars(50).nullable().optional(),
  remark: chars(200).nullable().optional(),
  referenceStoreAssetIds: ids(9).optional(),
  referenceFileIds: ids(9).optional(),
  expectChargePoints: positive,
  agreementVersionId: IdSchema,
  isAgreementChecked: z.boolean(),
});
export const AdConfirmBodySchema = z
  .strictObject({
    versionNo: positive,
    viewedVia: AdPreviewChannelSchema,
    hasViewed: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.viewedVia !== "weapp" && v.hasViewed !== true)
      ctx.addIssue({ code: "custom", path: ["hasViewed"], message: "请勾选已查看本版广告" });
  });
export const AdRequestChangeBodySchema = z
  .strictObject({
    versionNo: positive,
    segmentIndex: n.nullable().optional(),
    timeStartMs: n.nullable().optional(),
    timeEndMs: positive.nullable().optional(),
    note: chars(200).refine((v) => v.trim().length > 0),
    screenshotFileIds: ids(9).optional(),
    acceptChargePoints: n.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const timed = v.timeStartMs != null || v.timeEndMs != null;
    if (
      (v.segmentIndex != null && timed) ||
      (timed && (v.timeStartMs == null || v.timeEndMs == null || v.timeStartMs >= v.timeEndMs))
    )
      ctx.addIssue({ code: "custom", message: "分段与时间范围互斥，起止时间须完整且递增" });
  });
export const AdSubmitBodySchema = z.strictObject({
  copy: chars(50).nullable().optional(),
  remark: chars(200).nullable().optional(),
  addReferenceStoreAssetIds: ids(9).optional(),
  addReferenceFileIds: ids(9).optional(),
});
export const AdDownloadBodySchema = z.strictObject({ versionNo: positive });
export const AdListQuerySchema = z.strictObject({
  tab: z.enum(["all", "producing", "pending_confirm", "revising", "confirmed"]).default("all"),
  type: slot.optional(),
  isSelectable: z
    .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
    .optional(),
  sort: z.enum(["-updatedAt", "-submittedAt"]).default("-updatedAt"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const AdStateSchema = z
  .strictObject({
    adId: IdSchema,
    adNo: z.string(),
    status: openEnum(AD_STATUS.values),
    displayStatus: openEnum(["producing", "pending_confirm", "revising", "confirmed", "cancelled"]),
    waitingReason: openEnum(["materials", "qualification"]).nullable(),
    currentVersionNo: positive.nullable(),
    confirmedVersionNo: positive.nullable(),
    confirmedAt: InstantSchema.nullable(),
    revisionCount: n,
    freeRevisionsRemaining: n,
    chargePoints: n,
    isCaptured: z.boolean(),
    dueAt: InstantSchema.nullable(),
    dueKind: openEnum(["first_version", "revision"]).nullable(),
    hasOpenCancelRequest: z.boolean(),
    actions: z.array(z.string()),
  })
  .openapi("AdState");
export const AdSegmentSchema = z.strictObject({
  index: n,
  fromMs: n,
  toMs: positive,
  label: z.string(),
});
export const AdVersionSchema = z.strictObject({
  versionNo: positive,
  uploadedAt: InstantSchema,
  pushedAt: InstantSchema,
  durationMs: positive,
  width: positive,
  height: positive,
  segments: z.array(AdSegmentSchema),
  previewChannels: z.array(previewView),
  offlineSentAt: InstantSchema.nullable(),
  decision: openEnum(AD_VERSION_DECISION.values).nullable(),
  decidedAt: InstantSchema.nullable(),
  confirmViewedVia: previewView.nullable(),
  viewedAckAt: InstantSchema.nullable(),
});
export const AdRevisionWrittenSchema = z.strictObject({
  revisionNo: positive,
  onVersionNo: positive,
  source: openEnum(AD_REVISION_SOURCE.values),
  isChargeable: z.boolean(),
  chargePoints: n,
  segmentIndex: n.nullable(),
  timeStartMs: n.nullable(),
  timeEndMs: n.nullable(),
  note: z.string(),
  screenshotFileIds: ids(9),
  actorType: openEnum(ACTOR_TYPE.values),
  createdAt: InstantSchema,
  dueAt: InstantSchema,
  fulfilledByVersionNo: positive.nullable(),
});
export const AdRevisionViewSchema = AdRevisionWrittenSchema.omit({
  screenshotFileIds: true,
}).extend({ screenshots: z.array(ImageRefSchema) });
export const AdRevisionResultSchema = z.strictObject({
  ad: AdStateSchema,
  revision: AdRevisionWrittenSchema,
});
export const AdQuoteSchema = z.strictObject({
  unitPoints: n,
  discountBp: n.nullable(),
  chargePoints: n.nullable(),
  freeRevisions: n,
  planName: z.string().nullable(),
  availablePoints: n,
  availableAfterPoints: z.int().nullable(),
  typeOptions: z.array(
    z.strictObject({ type: openEnum(PLACEMENT_SLOT.values), durationOptions: z.array(positive) }),
  ),
  storeGate: openEnum(["full", "parallel", "blocked"]),
  blockers: z.array(QuoteBlockerSchema),
  agreement: z.strictObject({
    agreementKey: z.literal("ad_service"),
    name: z.string(),
    agreementVersionId: IdSchema,
    versionLabel: z.string(),
    needsCheck: z.boolean(),
  }),
  quotedAt: InstantSchema,
});
export const AdCardSchema = AdStateSchema.extend({
  type: openEnum(PLACEMENT_SLOT.values),
  durationSec: positive,
  returnReason: z.string().nullable(),
  copy: z.string().nullable(),
  promoPoints: z.array(DictRefSchema),
  coverUrl: z.string().nullable(),
  coverExpiresAt: InstantSchema.nullable(),
  currentPreviewChannels: z.array(previewView),
  isSelectable: z.boolean(),
  freeRevisionQuota: n,
  usage: z.strictObject({ inUseCount: n, firstDramaTitle: z.string().nullable() }),
  submittedAt: InstantSchema,
  updatedAt: InstantSchema,
});
export const AdReferenceSchema = z.strictObject({
  kind: z.enum(["store_asset", "profile_media"]),
  storeAssetId: IdSchema.nullable(),
  fileId: IdSchema.nullable(),
  assetType: z.string().nullable(),
  title: z.string().nullable(),
  mediaGroup: z.string().nullable(),
  category: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  thumbExpiresAt: InstantSchema.nullable(),
});
export const AdFloatingPlacementSchema = z.strictObject({
  orderItemId: IdSchema,
  orderId: IdSchema,
  orderNo: z.string(),
  dramaTitle: z.string(),
  slot,
  ticketStep: z.string().nullable(),
  isTicketPaused: z.boolean(),
  agreedLaunchDate: z.string().nullable(),
  serviceManagerName: z.string().nullable(),
});
export const AdRelatedServiceTicketSchema = z.strictObject({
  serviceTicketId: IdSchema,
  ticketNo: z.string(),
  status: z.string(),
  type: DictRefSchema,
  createdAt: InstantSchema,
});
export const AdDetailSchema = AdCardSchema.extend({
  remark: z.string().nullable(),
  unitPricePoints: n,
  discountBp: n,
  capturedAt: InstantSchema.nullable(),
  firstDueAt: InstantSchema.nullable(),
  editorName: z.string().nullable(),
  revisionUnitChargePoints: n.nullable(),
  revisionScreenshotMax: n,
  currentVersion: AdVersionSchema.nullable(),
  playable: PlayableSchema.nullable(),
  alternatives: z.strictObject({
    canSaveToAlbum: z.boolean(),
    canPreviewOnPortal: z.boolean(),
    isOfflineSent: z.boolean(),
  }),
  viewEvidence: z.strictObject({
    albumSavedAt: InstantSchema.nullable(),
    portalViewedAt: InstantSchema.nullable(),
  }),
  confirmableVia: z.array(previewView),
  versions: z.array(AdVersionSchema),
  revisions: z.array(AdRevisionViewSchema),
  references: z.array(AdReferenceSchema),
  floatingPlacements: z.array(AdFloatingPlacementSchema),
  relatedServiceTickets: z.array(AdRelatedServiceTicketSchema),
  timeline: z.array(
    z.strictObject({
      at: InstantSchema,
      action: z.string(),
      title: z.string(),
      detail: z.string().nullable(),
      versionNo: positive.nullable(),
      actorType: openEnum(ACTOR_TYPE.values),
    }),
  ),
});
export const AdPageSchema = z.strictObject({
  items: z.array(AdCardSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type AdCreateBody = z.infer<typeof AdCreateBodySchema>;
export type AdQuoteBody = z.infer<typeof AdQuoteBodySchema>;
export type AdConfirmBody = z.infer<typeof AdConfirmBodySchema>;
export type AdRequestChangeBody = z.infer<typeof AdRequestChangeBodySchema>;
export type AdSubmitBody = z.infer<typeof AdSubmitBodySchema>;
export type AdListQuery = z.infer<typeof AdListQuerySchema>;
