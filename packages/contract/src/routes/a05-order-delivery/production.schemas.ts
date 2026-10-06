import { z } from "../../zod.js";
import { IdSchema, InstantSchema, DictRefSchema, orNull } from "../../common/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import {
  AdminSampleViewSchema,
  QcRecordViewSchema,
  DeliveryTicketCardSchema,
} from "./delivery.schemas.js";
const n = z.int().nonnegative(),
  text = z.string(),
  at = orNull(InstantSchema),
  unique = <T>(a: T[]) => new Set(a).size === a.length;
export const SampleParamSchema = z.strictObject({ sampleId: IdSchema });
export const SampleAdSlotsSchema = z
  .array(
    z
      .strictObject({
        slot: z.enum(["opening", "ending"]),
        startMs: n,
        endMs: n,
        label: text.max(20),
      })
      .refine((r) => r.endMs > r.startMs),
  )
  .refine((a) => unique(a.map((r) => r.slot)));
export const SampleCreateBodySchema = z
  .strictObject({ fileId: IdSchema, adSlots: SampleAdSlotsSchema })
  .openapi("SampleCreateBody");
export const QualityResultsSchema = z
  .array(
    z.strictObject({
      key: text.min(1),
      result: z.enum(["pass", "fail", "na"]),
      note: orNull(text.max(200)).optional(),
    }),
  )
  .refine((a) => unique(a.map((r) => r.key)));
export const SampleInspectBodySchema = z
  .strictObject({
    checklistVersionNo: z.int().positive(),
    results: QualityResultsSchema,
    rejectReason: text.trim().min(1).max(200).optional(),
  })
  .openapi("SampleInspectBody");
export const SamplePushBodySchema = z
  .strictObject({ includeWecom: z.boolean().optional(), markWecomSent: z.boolean().optional() })
  .openapi("SamplePushBody");
export const AdminSampleWriteResultSchema = AdminSampleViewSchema.extend({
  replayed: z.boolean(),
}).openapi("AdminSampleWriteResult");
const episodeInput = z
  .strictObject({
    episodeNo: z.int().positive(),
    fileId: IdSchema.optional(),
    sampleId: IdSchema.optional(),
    variant: z.literal("common").optional(),
  })
  .refine((r) => !!r.fileId !== !!r.sampleId)
  .refine((r) => !r.sampleId || r.episodeNo === 1);
export const EpisodeRegisterBodySchema = z
  .strictObject({
    items: z
      .array(episodeInput)
      .min(1)
      .max(100)
      .refine((a) => unique(a.map((r) => r.episodeNo)))
      .optional(),
    uploadBatchId: IdSchema.optional(),
    reissueId: IdSchema.optional(),
    adoptedStoreAssetIds: z.array(IdSchema).max(20).refine(unique).optional(),
  })
  .refine((r) => !!r.items !== !!r.uploadBatchId)
  .openapi("EpisodeRegisterBody");
export const EpisodeOutputViewSchema = z
  .strictObject({
    episodeOutputId: IdSchema,
    episodeNo: z.int().positive(),
    variant: z.literal("common"),
    revisionNo: z.int().positive(),
    fileId: IdSchema,
    fileName: orNull(text),
    sizeBytes: text,
    durationMs: orNull(n),
    source: text,
    status: text,
    isCurrent: z.boolean(),
    deliveryReissueId: orNull(IdSchema),
    production: orNull(
      z.strictObject({
        pipelineState: text,
        gate: orNull(z.enum(["pass", "reject"])),
        softWarnCount: n,
        aigcState: text,
      }),
    ),
    qc: orNull(
      QcRecordViewSchema.pick({
        qcRecordId: true,
        verdict: true,
        rejectReason: true,
        inspectedAt: true,
        inspectedBy: true,
      }),
    ),
    uploadedBy: StaffBriefSchema,
    uploadedAt: InstantSchema,
  })
  .openapi("EpisodeOutputView");
export const EpisodeGridSchema = z
  .strictObject({
    totalEpisodes: n,
    currentPassedCount: n,
    currentTotalBytes: text,
    episodes: z.array(
      z.strictObject({
        episodeNo: z.int().positive(),
        current: orNull(EpisodeOutputViewSchema),
        latest: orNull(EpisodeOutputViewSchema),
        replacement: orNull(EpisodeOutputViewSchema),
      }),
    ),
    packageQc: orNull(QcRecordViewSchema),
    fileNamePattern: text,
  })
  .openapi("EpisodeGrid");
export const EpisodeRegisterResultSchema = z
  .strictObject({ items: z.array(EpisodeOutputViewSchema), replayed: z.boolean() })
  .openapi("EpisodeRegisterResult");
export const InspectEpisodesBodySchema = z
  .strictObject({
    episodeOutputIds: z.array(IdSchema).min(1).max(100).refine(unique),
    checklistVersionNo: z.int().positive(),
    defaultResults: QualityResultsSchema,
    defaultRejectReason: text.trim().min(1).max(200).optional(),
    exceptions: z
      .array(
        z.strictObject({
          episodeOutputId: IdSchema,
          results: QualityResultsSchema,
          rejectReason: text.trim().min(1).max(200).optional(),
        }),
      )
      .refine((a) => unique(a.map((r) => r.episodeOutputId)))
      .optional(),
  })
  .openapi("InspectEpisodesBody");
export const InspectEpisodesResultSchema = z
  .strictObject({
    results: z.array(
      z.strictObject({
        episodeOutputId: IdSchema,
        episodeNo: z.int().positive(),
        verdict: z.enum(["pass", "fail"]),
        qcRecordId: IdSchema,
      }),
    ),
    ticket: DeliveryTicketCardSchema,
    replayed: z.boolean(),
  })
  .openapi("InspectEpisodesResult");
export const InspectPackageBodySchema = SampleInspectBodySchema.openapi("InspectPackageBody");
export const InspectPackageResultSchema = z
  .strictObject({
    qcRecord: QcRecordViewSchema,
    ticket: DeliveryTicketCardSchema,
    replayed: z.boolean(),
  })
  .openapi("InspectPackageResult");
export const PushPackageBodySchema = z
  .strictObject({
    precheck: SampleInspectBodySchema.omit({ rejectReason: true }),
    ackAbnormalAccount: z.boolean().optional(),
    note: text.max(200).optional(),
  })
  .openapi("PushPackageBody");
export const ReleaseAdminViewSchema = z
  .strictObject({
    deliveryReleaseId: IdSchema,
    releaseNo: z.int().positive(),
    variant: z.enum(["common", "douyin", "wechat_channels"]),
    kind: z.enum(["initial", "reissue"]),
    state: z.enum(["pushed", "superseded", "closed"]),
    episodeCount: n,
    totalBytes: text,
    changedEpisodeNos: z.array(n),
    precheck: z.array(
      z.strictObject({
        key: text,
        label: text,
        result: z.enum(["pass", "fail", "na"]),
        note: orNull(text),
        merchantVisible: z.boolean(),
      }),
    ),
    reason: orNull(DictRefSchema),
    note: orNull(text),
    pushedBy: StaffBriefSchema,
    pushedAt: InstantSchema,
    supersededAt: at,
    closedAt: at,
    closeReason: orNull(z.enum(["cancelled", "usage_ended"])),
    savedEpisodeCount: n,
  })
  .openapi("ReleaseAdminView");
export const PushPackageResultSchema = z
  .strictObject({
    release: ReleaseAdminViewSchema,
    grantExpiresAt: InstantSchema,
    launchTaskCount: n,
    ticket: DeliveryTicketCardSchema,
    replayed: z.boolean(),
  })
  .openapi("PushPackageResult");
export type SampleCreateBody = z.infer<typeof SampleCreateBodySchema>;
export type SampleInspectBody = z.infer<typeof SampleInspectBodySchema>;
export type SamplePushBody = z.infer<typeof SamplePushBodySchema>;
export type EpisodeRegisterBody = z.infer<typeof EpisodeRegisterBodySchema>;
export type InspectEpisodesBody = z.infer<typeof InspectEpisodesBodySchema>;
export type PushPackageBody = z.infer<typeof PushPackageBodySchema>;
