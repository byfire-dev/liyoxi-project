// W3-09: a04 §§2–3; request schemas are strict, response enums remain forward compatible.
import { z } from "../../zod.js";
import {
  IdSchema,
  InstantSchema,
  DateSchema,
  DictRefSchema,
  PageQuerySchema,
  CursorQuerySchema,
  openEnum,
} from "../../common/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { DramaFileBriefSchema, TrailerBriefSchema } from "./drama-copyright.schemas.js";
const count = z.int().nonnegative();
const text = (min: number, max: number) =>
  z
    .string()
    .refine(
      (v) => [...v].length >= min && [...v].length <= max && (min === 0 || v.trim().length > 0),
    );
const codes = z.array(z.string().min(1)).refine((v) => new Set(v).size === v.length);
const ids = z
  .array(IdSchema)
  .max(10)
  .refine((v) => new Set(v).size === v.length);
const platform = z.enum(["all", "douyin", "wechat_channels"]);
const kind = z.enum(["license_no", "approval_no", "program_no"]);
const multi = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().refine((v) => v.split(",").every((item) => values.includes(item)));
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const DramaCreateBodySchema = z
  .strictObject({ title: text(1, 20) })
  .openapi("DramaCreateBody");
export const DramaBasicBodySchema = z
  .strictObject({
    lockVersion: count,
    title: text(1, 20).optional(),
    posterFileId: IdSchema.nullable().optional(),
    totalEpisodes: z.int().min(1).max(999).nullable().optional(),
    episodeDurationSec: z.int().positive().nullable().optional(),
    genreCodes: codes.optional(),
    sellingTagCodes: codes.max(3).optional(),
    producerName: text(0, 50).nullable().optional(),
    castNames: text(0, 100).nullable().optional(),
    synopsis: text(0, 300).nullable().optional(),
    dramaClass: z.enum(["class_1", "class_2", "class_3"]).nullable().optional(),
    isAiGenerated: z.boolean().optional(),
  })
  .openapi("DramaBasicBody");
export const DramaCommercialBodySchema = z
  .strictObject({
    lockVersion: count,
    heatTier: z.enum(["S", "A", "B", "C"]).nullable().optional(),
    manualBoost: z.int().min(0).max(100).optional(),
    industryCodes: codes.optional(),
    targetAudience: text(0, 100).nullable().optional(),
    allowedPlacements: z
      .array(z.enum(["opening", "ending", "corner", "mid_roll"]))
      .refine((v) => new Set(v).size === v.length)
      .optional(),
  })
  .openapi("DramaCommercialBody");
export const DramaCastBodySchema = z
  .strictObject({
    lockVersion: count,
    roles: z
      .array(
        z.strictObject({
          name: text(1, 20),
          actor: text(0, 20).nullable().optional(),
          desc: text(1, 100),
        }),
      )
      .max(8),
  })
  .openapi("DramaCastBody");
export const DramaDelistBodySchema = z
  .strictObject({
    reasonCode: z.enum(["ops_strategy", "rights_issue", "content_revision", "other"]),
    note: text(0, 200).nullable().optional(),
  })
  .openapi("DramaDelistBody");
export const DramaShelveBodySchema = z.strictObject({}).openapi("DramaShelveBody");
export const DramaTrailerBodySchema = z
  .strictObject({ sourceFileId: IdSchema })
  .openapi("DramaTrailerBody");
const permitShape = {
  platform,
  permitKind: kind,
  permitNo: text(1, 50),
  scanFileIds: ids.default([]),
  note: text(0, 200).nullable().optional(),
};
export const DramaPermitCreateBodySchema = z
  .strictObject({
    ...permitShape,
    replacesDramaPermitId: IdSchema.nullable().optional(),
    retireReason: text(1, 200).optional(),
  })
  .refine((v) => !v.replacesDramaPermitId || !!v.retireReason, { path: ["retireReason"] })
  .openapi("DramaPermitCreateBody");
export const DramaPermitUpdateBodySchema = z
  .strictObject({
    dramaLockVersion: count,
    platform: platform.optional(),
    permitKind: kind.optional(),
    permitNo: text(1, 50).optional(),
    scanFileIds: ids.optional(),
    note: text(0, 200).nullable().optional(),
  })
  .openapi("DramaPermitUpdateBody");
export const DramaPermitRetireBodySchema = z
  .strictObject({ retireReason: text(1, 200) })
  .openapi("DramaPermitRetireBody");
export const DramaEpisodeUpdateBodySchema = z
  .strictObject({ dramaLockVersion: count, title: text(0, 30).nullable() })
  .openapi("DramaEpisodeUpdateBody");
const filterShape = {
  q: text(0, 20).optional(),
  status: multi(["draft", "listed", "delisted"]).optional(),
  genreCode: z.string().min(1).optional(),
  industryCode: z.string().min(1).optional(),
  heatTier: multi(["S", "A", "B", "C"]).optional(),
  dramaClass: multi(["class_1", "class_2", "class_3"]).optional(),
  isExpiringSoon: bool.optional(),
  isOrderable: bool.optional(),
  isArchived: bool.optional(),
};
export const DramaListQuerySchema = PageQuerySchema.extend({
  ...filterShape,
  pageSize: z.coerce.number().int().min(1).max(100).default(12),
  sort: z
    .enum(["-updatedAt", "-createdAt", "-firstListedAt", "licenseEndDate", "-ordersMtd", "title"])
    .default("-updatedAt"),
})
  .strict()
  .openapi("DramaListQuery");
export const DramaSummaryQuerySchema = z.strictObject(filterShape).openapi("DramaSummaryQuery");
export const DramaEpisodeListQuerySchema = PageQuerySchema.extend({
  masterState: multi(["missing", "processing", "ready"]).optional(),
})
  .strict()
  .openapi("DramaEpisodeListQuery");
export const DramaPermitListQuerySchema = z
  .strictObject({ status: multi(["active", "retired"]).optional() })
  .openapi("DramaPermitListQuery");
export const DramaActivityQuerySchema = CursorQuerySchema.strict().openapi("DramaActivityQuery");
export const DramaRowSchema = z
  .object({
    dramaId: IdSchema,
    title: z.string(),
    posterUrl: SignedUrlSchema.nullable(),
    genres: z.array(DictRefSchema),
    industries: z.array(DictRefSchema),
    dramaClass: openEnum(["class_1", "class_2", "class_3"]).nullable(),
    totalEpisodes: count.nullable(),
    heatTier: openEnum(["S", "A", "B", "C"]).nullable(),
    listPricePoints: count.nullable(),
    templatePoints: count.nullable(),
    priceMode: openEnum(["template", "custom"]).nullable(),
    status: openEnum(["draft", "listed", "delisted"]),
    archivedAt: InstantSchema.nullable(),
    liveItems: count.nullable(),
    ordersMtd: count.nullable(),
    statRefreshedAt: InstantSchema.nullable(),
    licenseEndDate: DateSchema.nullable(),
    stopOrderDate: DateSchema.nullable(),
    licenseFlag: openEnum(["license_ended", "stopped", "not_listed", "orderable"]),
    isExpiringSoon: z.boolean(),
    shelveBlockedReason: z.string().nullable(),
    actions: z.array(openEnum(["shelve", "delist"])),
    updatedAt: InstantSchema,
  })
  .openapi("DramaRow");
export const DramaListResultSchema = z
  .object({ items: z.array(DramaRowSchema), page: count, pageSize: count, total: count })
  .openapi("DramaListResult");
export const DramaSummarySchema = z
  .object({
    counts: z.object({ draft: count, listed: count, delisted: count }),
    archived: count,
    stopped: count,
    expiringSoon: count,
    expiringSoonStopped: count,
    expiringWindowDays: count,
    minLicenseMonths: count,
  })
  .openapi("DramaSummary");
export const DramaPermitSchema = z
  .object({
    dramaPermitId: IdSchema,
    platform: openEnum(["all", "douyin", "wechat_channels"]),
    permitKind: openEnum(["license_no", "approval_no", "program_no"]),
    permitNo: z.string(),
    scanFiles: z.array(DramaFileBriefSchema),
    status: openEnum(["active", "retired"]),
    retiredAt: InstantSchema.nullable(),
    retireReason: z.string().nullable(),
    note: z.string().nullable(),
    isFrozen: z.boolean(),
    createdBy: StaffBriefSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    actions: z.array(openEnum(["retire"])),
  })
  .openapi("DramaPermit");
export const DramaPermitListResultSchema = z
  .object({
    items: z.array(DramaPermitSchema),
    dramaClass: openEnum(["class_1", "class_2", "class_3"]).nullable(),
    requiredKinds: z.array(openEnum(["license_no", "approval_no", "program_no"])),
    dramaLockVersion: count,
  })
  .openapi("DramaPermitListResult");
export const DramaPermitWriteResultSchema = z
  .object({ permit: DramaPermitSchema, dramaLockVersion: count })
  .openapi("DramaPermitWriteResult");
export const DramaPermitCreateResultSchema = DramaPermitWriteResultSchema.extend({
  retiredPermit: DramaPermitSchema.nullable(),
}).openapi("DramaPermitCreateResult");
export const DramaEpisodeRowSchema = z
  .object({
    dramaEpisodeId: IdSchema,
    episodeNo: z.int().positive(),
    title: z.string().nullable(),
    durationMs: count.nullable(),
    masterState: openEnum(["missing", "processing", "ready"]),
    currentMaster: z
      .object({
        dramaEpisodeMasterId: IdSchema,
        revNo: z.int().positive(),
        file: DramaFileBriefSchema,
        durationMs: count.nullable(),
        activatedAt: InstantSchema.nullable(),
        replaceReason: z.string().nullable(),
        isContentChanged: z.boolean(),
      })
      .nullable(),
    openUploadBatchId: IdSchema.nullable(),
    updatedAt: InstantSchema,
  })
  .openapi("DramaEpisodeRow");
export const DramaEpisodeListResultSchema = z
  .object({ items: z.array(DramaEpisodeRowSchema), page: count, pageSize: count, total: count })
  .openapi("DramaEpisodeListResult");
export const DramaEpisodeWriteResultSchema = z
  .object({ episode: DramaEpisodeRowSchema, dramaLockVersion: count })
  .openapi("DramaEpisodeWriteResult");
export const MediaReadinessSchema = z
  .object({
    trailer: TrailerBriefSchema.nullable(),
    isTrailerReady: z.boolean(),
    poster: z
      .object({ fileId: IdSchema, moderationState: z.string(), isBlocked: z.boolean() })
      .nullable(),
    masters: z.object({
      totalEpisodes: count.nullable(),
      withCurrentMaster: count,
      missingEpisodeNos: z.array(z.int().positive()).max(100),
    }),
    openUploadBatches: z.array(
      z.object({
        uploadBatchId: IdSchema,
        state: z.string(),
        scope: z.string(),
        createdBy: StaffBriefSchema,
        expiresAt: InstantSchema,
      }),
    ),
  })
  .openapi("MediaReadiness");
export const DramaTrailerWriteResultSchema = TrailerBriefSchema.extend({
  replayed: z.boolean(),
}).openapi("DramaTrailerWriteResult");
export const ActivityItemSchema = z
  .object({
    activityId: IdSchema,
    occurredAt: InstantSchema,
    actorType: openEnum(["merchant", "staff", "system", "partner"]),
    actorName: z.string().nullable(),
    actorRole: z.string().nullable(),
    client: z.string().nullable(),
    action: z.string(),
    summary: z.string(),
    targetType: z.string(),
    targetId: IdSchema.nullable(),
    targetLabel: z.string().nullable(),
    reasonText: z.string().nullable(),
    transition: z
      .object({
        machine: z.string(),
        stateField: z.string(),
        fromState: z.string().nullable(),
        toState: z.string(),
        event: z.string(),
        isForced: z.boolean(),
      })
      .nullable(),
  })
  .openapi("ActivityItem");
export const DramaActivityResultSchema = z
  .object({
    items: z.array(ActivityItemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    totalApprox: count,
  })
  .openapi("DramaActivityResult");
export type DramaListQuery = z.infer<typeof DramaListQuerySchema>;
export type DramaEpisodeListQuery = z.infer<typeof DramaEpisodeListQuerySchema>;
export type DramaPermitUpdateBody = z.infer<typeof DramaPermitUpdateBodySchema>;
export type DramaPermitCreateBody = z.infer<typeof DramaPermitCreateBodySchema>;
export type DramaRow = z.infer<typeof DramaRowSchema>;
export type DramaEpisodeRow = z.infer<typeof DramaEpisodeRowSchema>;
export type DramaPermit = z.infer<typeof DramaPermitSchema>;
export type MediaReadiness = z.infer<typeof MediaReadinessSchema>;
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
