// W3-10; a04 §2.4/2.9/2.10/3.10/3.11/3.20.
import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  DictRefSchema,
  openEnum,
} from "../../common/index.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { DramaPricingSchema } from "./drama-pricing.schemas.js";
const text = (max: number) => z.string().refine((v) => [...v].length <= max);
const count = z.int().nonnegative();
const copyrightShape = {
  source: z.enum(["own", "licensed"]).nullable(),
  platforms: z
    .array(z.enum(["douyin", "wechat_channels"]))
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  territory: text(50).nullable(),
  hasNetworkRight: z.boolean(),
  canSublicense: z.boolean(),
  canEditEmbed: z.boolean(),
  canAdapt: z.boolean(),
  licenseStartDate: DateSchema.nullable(),
  licenseEndDate: DateSchema.nullable(),
  proofFileIds: z
    .array(IdSchema)
    .max(10)
    .refine((v) => new Set(v).size === v.length),
};
const dates = (
  v: { licenseStartDate: string | null; licenseEndDate: string | null },
  c: z.RefinementCtx,
) => {
  if (v.licenseStartDate && v.licenseEndDate && v.licenseStartDate > v.licenseEndDate)
    c.addIssue({ code: "custom", path: ["licenseEndDate"], message: "止日不可早于起日" });
};
export const CopyrightReplaceBodySchema = z
  .strictObject({ ...copyrightShape, lockVersion: count })
  .superRefine(dates)
  .openapi("CopyrightReplaceBody");
export const DramaCopyrightSnapshotSchema = z
  .strictObject({ ...copyrightShape, licenseEndDate: DateSchema })
  .superRefine(dates)
  .openapi("DramaCopyrightSnapshot");
export const CopyrightRevisionCreateBodySchema = z
  .strictObject({
    lockVersion: count,
    changeKind: z.enum(["extend", "shorten", "scope_change", "correction"]),
    copyright: DramaCopyrightSnapshotSchema,
    reason: text(200).refine((v) => [...v].length >= 1),
    revisionProofFileIds: z
      .array(IdSchema)
      .min(1)
      .max(10)
      .refine((v) => new Set(v).size === v.length),
    confirm: z.strictObject({ prevEndDate: DateSchema }),
  })
  .openapi("CopyrightRevisionCreateBody");
export const ConfirmPermitRecheckBodySchema = z
  .strictObject({ note: text(200).nullable().optional() })
  .openapi("ConfirmPermitRecheckBody");
export const DramaFileBriefSchema = z
  .object({
    fileId: IdSchema,
    originalName: z.string().nullable(),
    sizeBytes: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    mime: z.string().nullable(),
    status: openEnum(["pending", "confirming", "stored", "failed", "expired", "purged"]),
    moderationState: openEnum([
      "pending",
      "pass",
      "review",
      "block",
      "unavailable",
      "not_required",
    ]),
  })
  .openapi("DramaFileBrief");
export const CopyrightRevisionSchema = z
  .object({
    dramaCopyrightRevisionId: IdSchema,
    changeKind: openEnum(["initial", "extend", "shorten", "scope_change", "correction"]),
    snapshot: DramaCopyrightSnapshotSchema,
    prevEndDate: DateSchema.nullable(),
    newEndDate: DateSchema,
    reason: z.string(),
    proofFiles: z.array(DramaFileBriefSchema),
    createdBy: StaffBriefSchema,
    createdAt: InstantSchema,
  })
  .openapi("CopyrightRevision");
export const ListingCheckResultSchema = z
  .object({
    isShelvable: z.boolean(),
    passedCount: count,
    total: count,
    evaluatedAt: InstantSchema,
    items: z.array(
      z.object({
        code: z.string(),
        label: z.string(),
        severity: openEnum(["block", "hint"]),
        isOk: z.boolean(),
        note: z.string().nullable(),
        fixTab: openEnum(["basic", "commercial", "episodes", "license", "copyright"]).nullable(),
      }),
    ),
  })
  .openapi("ListingCheckResult");
export const TrailerBriefSchema = z
  .object({
    targetPlayableId: IdSchema,
    currentPlayableId: IdSchema.nullable(),
    state: openEnum(["processing", "ready", "failed", "retired"]),
    sourceFile: DramaFileBriefSchema,
    durationMs: count.nullable(),
    width: count.nullable(),
    height: count.nullable(),
    coverUrl: SignedUrlSchema.nullable(),
    error: z.string().nullable(),
    setBy: StaffBriefSchema,
    setAt: InstantSchema,
    readyAt: InstantSchema.nullable(),
  })
  .openapi("TrailerBrief");
export const DramaCopyrightSchema = z
  .object({
    source: openEnum(["own", "licensed"]).nullable(),
    platforms: z.array(openEnum(["douyin", "wechat_channels"])),
    territory: z.string().nullable(),
    hasNetworkRight: z.boolean(),
    canSublicense: z.boolean(),
    canEditEmbed: z.boolean(),
    canAdapt: z.boolean(),
    licenseStartDate: DateSchema.nullable(),
    licenseEndDate: DateSchema.nullable(),
    proofFiles: z.array(DramaFileBriefSchema),
    currentRevisionId: IdSchema.nullable(),
    stopOrderDate: DateSchema.nullable(),
    licenseFlag: openEnum(["license_ended", "stopped", "not_listed", "orderable"]),
    isExpiringSoon: z.boolean(),
    editMode: openEnum(["direct", "revision", "locked"]),
    lockVersion: count,
  })
  .openapi("DramaCopyright");
export const AdminDramaDetailSchema = z
  .object({
    dramaId: IdSchema,
    title: z.string(),
    status: openEnum(["draft", "listed", "delisted"]),
    archivedAt: InstantSchema.nullable(),
    statusChangedAt: InstantSchema,
    firstListedAt: InstantSchema.nullable(),
    listedAt: InstantSchema.nullable(),
    delistedAt: InstantSchema.nullable(),
    delistReasonCode: openEnum([
      "ops_strategy",
      "rights_issue",
      "content_revision",
      "other",
      "license_expired",
    ]).nullable(),
    delistNote: z.string().nullable(),
    createdAt: InstantSchema,
    createdBy: StaffBriefSchema,
    updatedAt: InstantSchema,
    updatedBy: StaffBriefSchema,
    lockVersion: count,
    posterFileId: IdSchema.nullable(),
    posterUrl: SignedUrlSchema.nullable(),
    totalEpisodes: count.nullable(),
    episodeDurationSec: count.nullable(),
    genres: z.array(DictRefSchema),
    sellingTags: z.array(DictRefSchema),
    producerName: z.string().nullable(),
    castNames: z.string().nullable(),
    synopsis: z.string().nullable(),
    roles: z.array(z.object({ name: z.string(), actor: z.string().nullable(), desc: z.string() })),
    dramaClass: openEnum(["class_1", "class_2", "class_3"]).nullable(),
    isAiGenerated: z.boolean(),
    heatTier: openEnum(["S", "A", "B", "C"]).nullable(),
    manualBoost: count,
    industries: z.array(DictRefSchema),
    targetAudience: z.string().nullable(),
    allowedPlacements: z.array(openEnum(["opening", "ending", "corner", "mid_roll"])),
    openPlacementSlots: z.array(openEnum(["opening", "ending", "corner", "mid_roll"])),
    trialEpisodeCount: count.nullable(),
    isPermitRecheckRequired: z.boolean(),
    bodyEditPolicy: openEnum(["undecided", "allowed", "forbidden"]),
    copyright: DramaCopyrightSchema,
    trailer: TrailerBriefSchema.nullable(),
    episodeSummary: z.object({ total: count, withCurrentMaster: count, processing: count }),
    pricing: DramaPricingSchema,
    listingChecks: ListingCheckResultSchema,
    actions: z.array(openEnum(["shelve", "delist", "confirm-permit-recheck"])),
    editability: z.object({
      canEditContent: z.boolean(),
      copyrightEditMode: openEnum(["direct", "revision", "locked"]),
      canManageMedia: z.boolean(),
      canReprice: z.boolean(),
    }),
  })
  .openapi("AdminDramaDetail");
export const AdminDramaWriteResultSchema = AdminDramaDetailSchema.extend({
  replayed: z.boolean(),
}).openapi("AdminDramaWriteResult");
export const CopyrightRevisionCreateResultSchema = z
  .object({
    revision: CopyrightRevisionSchema,
    drama: AdminDramaDetailSchema,
    replayed: z.boolean(),
  })
  .openapi("CopyrightRevisionCreateResult");
export type CopyrightReplaceBody = z.infer<typeof CopyrightReplaceBodySchema>;
export type CopyrightRevisionCreateBody = z.infer<typeof CopyrightRevisionCreateBodySchema>;
export type AdminDramaDetail = z.infer<typeof AdminDramaDetailSchema>;
export type CopyrightRevision = z.infer<typeof CopyrightRevisionSchema>;

export type CopyrightRevisionCreateResult = z.infer<typeof CopyrightRevisionCreateResultSchema>;
