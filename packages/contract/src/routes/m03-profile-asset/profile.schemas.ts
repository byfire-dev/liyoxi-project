import { z } from "../../zod.js";
import { DictRefSchema, IdSchema, InstantSchema, openEnum } from "../../common/index.js";
import { QUALIFICATION_STATUS, STORE_PROFILE_MEDIA_MEDIA_GROUP } from "../../enums/index.js";

export const StepStateSchema = openEnum(["not_started", "in_progress", "completed"]);
export const MissingItemSchema = z.object({
  item: openEnum([
    "brand_name",
    "store_name",
    "industry",
    "address",
    "business_hours",
    "store_tel",
    "avg_spend",
    "door_photos",
    "interior_photos",
    "service",
    "selling_points",
    "entity_type",
    "business_license",
    "contact",
    "declaration",
    "permit",
  ]),
  permitType: z.string().nullable(),
});
export const CompletenessSchema = z
  .object({
    pct: z.int().min(0).max(100),
    requiredFilled: z.int().min(0),
    requiredTotal: z.int().min(0),
    steps: z
      .array(
        z.object({
          step: z.int().min(1).max(4),
          state: StepStateSchema,
          missing: z.array(MissingItemSchema),
        }),
      )
      .length(4),
  })
  .openapi("Completeness");
export const MediaFileViewSchema = z
  .object({
    fileId: IdSchema,
    kind: openEnum(["image", "video", "audio", "document"]),
    url: z.string().nullable(),
    expiresAt: InstantSchema.nullable(),
    coverUrl: z.string().nullable(),
    durationMs: z.int().nullable(),
    displayWidth: z.int().nullable(),
    displayHeight: z.int().nullable(),
    moderationState: openEnum(["none", "pending", "pass", "review", "block"]),
  })
  .openapi("MediaFileView");
export const AddressViewSchema = z
  .object({
    province: DictRefSchema.nullable(),
    city: DictRefSchema.nullable(),
    district: DictRefSchema.nullable(),
    zone: DictRefSchema.nullable(),
    detail: z.string().nullable(),
    poiName: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .openapi("AddressView");
export const AddressInputSchema = z
  .object({
    provinceCode: z.string().nullable(),
    cityCode: z.string().nullable(),
    districtCode: z.string().nullable(),
    zoneCode: z.string().nullable(),
    detail: z.string().max(200).nullable(),
    poiName: z.string().nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
  })
  .refine((a) => (a.latitude === null) === (a.longitude === null), "经纬度须同时给出");
export const BusinessHourSlotSchema = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .refine((slot) => slot.start !== slot.end, "营业时段的起止不能相同");
const basic = {
  brandName: z.string().nullable(),
  logo: MediaFileViewSchema.nullable(),
  storeName: z.string().nullable(),
  industry: DictRefSchema.nullable(),
  category: DictRefSchema.nullable(),
  address: AddressViewSchema,
  businessHours: z.array(BusinessHourSlotSchema),
  storeTel: z.string().nullable(),
  avgSpendFen: z.int().nullable(),
  brandIntro: z.string().nullable(),
  reviewFieldsLocked: z.boolean(),
  reviewRequiredOnChange: z.boolean(),
  lastEditedAt: InstantSchema.nullable(),
  completeness: CompletenessSchema,
};
export const StoreProfileBasicOwnerSchema = z.object({
  viewerRole: z.literal("owner"),
  ...basic,
  pendingChange: z.null(),
  lockVersion: z.int(),
});
export const StoreProfileBasicClerkSchema = z.object({ viewerRole: z.literal("clerk"), ...basic });
export const StoreProfileBasicSchema = z
  .discriminatedUnion("viewerRole", [StoreProfileBasicOwnerSchema, StoreProfileBasicClerkSchema])
  .openapi("StoreProfileBasic");
export const StoreProfileBasicPatchSchema = z
  .object({
    draft: z.boolean(),
    lockVersion: z.int().min(0),
    confirmReview: z.boolean().optional(),
    brandName: z.string().min(2).max(30).nullable().optional(),
    logoFileId: IdSchema.nullable().optional(),
    storeName: z.string().min(2).max(30).nullable().optional(),
    industryCode: z.string().nullable().optional(),
    categoryCode: z.string().nullable().optional(),
    address: AddressInputSchema.nullable().optional(),
    businessHours: z.array(BusinessHourSlotSchema).max(4).optional(),
    storeTel: z
      .string()
      .max(20)
      .regex(/^(?:1\d{10}|0\d{2,3}-?\d{7,8}(?:-\d{1,6})?)$/)
      .nullable()
      .optional(),
    avgSpendFen: z.int().min(0).nullable().optional(),
    brandIntro: z.string().max(300).nullable().optional(),
  })
  .refine(
    (v) => (v.industryCode === undefined) === (v.categoryCode === undefined),
    "行业与品类须同时传入",
  );
const mediaItem = z.object({
  mediaItemId: IdSchema,
  position: z.int().min(1),
  mediaKind: openEnum(["image", "video"]),
  file: MediaFileViewSchema,
  isCopied: z.boolean(),
});
const groups = z.object({
  door: z.array(mediaItem),
  interior: z.array(mediaItem),
  product: z.array(mediaItem),
  promo: z.array(mediaItem),
});
export const StoreProfileMediaOwnerSchema = z.object({
  viewerRole: z.literal("owner"),
  groups,
  lockVersion: z.int(),
  completeness: CompletenessSchema,
});
export const StoreProfileMediaClerkSchema = StoreProfileMediaOwnerSchema.omit({
  lockVersion: true,
}).extend({ viewerRole: z.literal("clerk") });
export const StoreProfileMediaSchema = z
  .discriminatedUnion("viewerRole", [StoreProfileMediaOwnerSchema, StoreProfileMediaClerkSchema])
  .openapi("StoreProfileMedia");
export const StoreProfileMediaPatchSchema = z.object({
  draft: z.boolean(),
  lockVersion: z.int().min(0),
  groups: z
    .partialRecord(
      z.enum(STORE_PROFILE_MEDIA_MEDIA_GROUP.values),
      z.array(z.object({ fileId: IdSchema })).max(12),
    )
    .refine((v) => Object.keys(v).length > 0, "至少一组媒体"),
});
export const ServiceItemSchema = z.object({
  serviceItemId: IdSchema,
  position: z.int().min(1),
  name: z.string(),
  priceFen: z.int(),
  originalPriceFen: z.int().nullable(),
  image: MediaFileViewSchema.nullable(),
  intro: z.string().nullable(),
});
const service = {
  serviceItems: z.array(ServiceItemSchema),
  promoText: z.string().nullable(),
  groupBuyText: z.string().nullable(),
  sellingPoints: z.array(DictRefSchema),
  sellingNote: z.string().nullable(),
  completeness: CompletenessSchema,
};
export const StoreProfileServiceOwnerSchema = z.object({
  viewerRole: z.literal("owner"),
  ...service,
  lockVersion: z.int(),
});
export const StoreProfileServiceClerkSchema = z.object({
  viewerRole: z.literal("clerk"),
  ...service,
});
export const StoreProfileServiceSchema = z
  .discriminatedUnion("viewerRole", [
    StoreProfileServiceOwnerSchema,
    StoreProfileServiceClerkSchema,
  ])
  .openapi("StoreProfileService");
export const ServiceItemInputSchema = z
  .object({
    serviceItemId: IdSchema.optional(),
    name: z.string().min(1).max(30),
    priceFen: z.int().positive(),
    originalPriceFen: z.int().nullable().optional(),
    imageFileId: IdSchema.nullable().optional(),
    intro: z.string().max(20).nullable().optional(),
  })
  .refine(
    (item) => item.originalPriceFen == null || item.originalPriceFen >= item.priceFen,
    "原价不得低于现价",
  );
export const StoreProfileServicePatchSchema = z.object({
  draft: z.boolean(),
  lockVersion: z.int().min(0),
  serviceItems: z.array(ServiceItemInputSchema).max(10).optional(),
  promoText: z.string().max(100).nullable().optional(),
  groupBuyText: z.string().max(100).nullable().optional(),
  sellingPointCodes: z
    .array(z.string())
    .max(5)
    .refine((v) => new Set(v).size === v.length, "卖点不能重复")
    .optional(),
  sellingNote: z.string().max(100).nullable().optional(),
});
const step = z.object({ state: StepStateSchema });
const qualification = z.object({ status: openEnum(QUALIFICATION_STATUS.values) });
const members = z.object({
  ownerDisplayName: z.string().nullable(),
  clerkCount: z.int(),
  preview: z.array(
    z.object({ displayName: z.string().nullable(), role: openEnum(["owner", "clerk"]) }),
  ),
});
const steps = z.object({
  basic: step,
  media: step.extend({
    doorCount: z.int(),
    interiorCount: z.int(),
    productCount: z.int(),
    promoCount: z.int(),
  }),
  service: step.extend({
    serviceItemCount: z.int(),
    sellingPointCount: z.int(),
    hasPromoText: z.boolean(),
  }),
  qualification: step,
});
const overview = {
  store: z.object({
    storeId: IdSchema,
    name: z.string().nullable(),
    isPrimary: z.boolean(),
    qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
    isChangeInReview: z.boolean(),
    isFinalRejected: z.boolean(),
    industry: DictRefSchema.nullable(),
    category: DictRefSchema.nullable(),
  }),
  completeness: CompletenessSchema,
  assets: z.object({
    total: z.int(),
    recent7dCount: z.int(),
    recent: z.array(z.object({})).max(0),
  }),
};
export const StoreProfileOverviewClerkSchema = z.object({
  viewerRole: z.literal("clerk"),
  ...overview,
  steps,
  qualification,
  members,
});
export const StoreProfileOverviewOwnerSchema = z.object({
  viewerRole: z.literal("owner"),
  ...overview,
  entityName: z.string().nullable(),
  steps: steps.extend({
    qualification: step.extend({
      docTypes: z.array(
        z.object({
          docType: openEnum(["business_license", "branch_license", "industry_permit"]),
          permitType: DictRefSchema.nullable(),
        }),
      ),
    }),
  }),
  qualification: qualification.extend({
    submittedAt: InstantSchema.nullable(),
    dueAt: InstantSchema.nullable(),
    lastDecidedAt: InstantSchema.nullable(),
  }),
  members: members.extend({ pendingInvitationCount: z.int() }),
  ads: z.object({
    confirmedCount: z.int(),
    pendingConfirmCount: z.int(),
    producingCount: z.int(),
    revisingCount: z.int(),
  }),
});
export const StoreProfileOverviewSchema = z
  .discriminatedUnion("viewerRole", [
    StoreProfileOverviewOwnerSchema,
    StoreProfileOverviewClerkSchema,
  ])
  .openapi("StoreProfileOverview");
export const ReplayFlagSchema = z.object({ replayed: z.boolean() });
export type StoreProfileBasicPatch = z.infer<typeof StoreProfileBasicPatchSchema>;
export type StoreProfileMediaPatch = z.infer<typeof StoreProfileMediaPatchSchema>;
export type StoreProfileServicePatch = z.infer<typeof StoreProfileServicePatchSchema>;
export type MediaFileView = z.infer<typeof MediaFileViewSchema>;
export type Completeness = z.infer<typeof CompletenessSchema>;
