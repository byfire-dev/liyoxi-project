import { z } from "../../zod.js";
import {
  IdSchema,
  InstantSchema,
  DictRefSchema,
  PageQuerySchema,
  orNull,
} from "../../common/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";
import {
  AdminSampleViewSchema,
  QcRecordViewSchema,
  DeliveryTicketCardSchema,
} from "./delivery.schemas.js";
import { OrderReferenceFileSchema } from "./order-read.schemas.js";
import { BatchAiUsageSchema } from "../a04-content/upload-batches.schemas.js";
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
  .strictObject({
    includeWecom: z.boolean().optional(),
    markWecomSent: z.boolean().optional(),
    legacyRecovery: z
      .strictObject({
        versionNo: z.int().positive(),
        reason: text.trim().min(10).max(200),
        quality: SampleInspectBodySchema,
      })
      .optional(),
  })
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

// W5-04: manual production controls and staff material access.
const ProductionKindSchema = z.enum(["sample", "final", "ad"]);
const PipelineStateSchema = z.enum(["uploading", "checking", "ready", "rejected"]);
const ProductionToolSchema = z.strictObject({
  name: text.trim().min(1).max(50),
  version: text.trim().min(1).max(50),
  usedFor: text.trim().min(1).max(50),
});
export const ProductionRecordParamSchema = z.strictObject({ productionRecordId: IdSchema });
export const ProductionRecordQuerySchema = PageQuerySchema.extend({
  fileIds: z
    .union([
      text
        .min(1)
        .max(3699)
        .transform((value) => value.split(","))
        .pipe(z.array(IdSchema).min(1).max(100).refine(unique)),
      z.array(IdSchema).min(1).max(100).refine(unique),
    ])
    .optional(),
  orderItemId: IdSchema.optional(),
  adId: IdSchema.optional(),
  kind: ProductionKindSchema.optional(),
  episodeNo: z.coerce.number().int().positive().optional(),
  pipelineState: PipelineStateSchema.optional(),
})
  .refine((q) => !!q.fileIds || !!q.orderItemId || !!q.adId)
  .openapi("ProductionRecordQuery");
export const NormalizeBodySchema = z
  .strictObject({ note: text.max(200).optional() })
  .openapi("NormalizeBody");
export const RestampBodySchema = z
  .strictObject({
    tools: z.array(ProductionToolSchema).min(1),
    note: text.trim().min(1).max(200),
  })
  .openapi("RestampBody");
export const RecheckBodySchema = z.strictObject({}).openapi("RecheckBody");
const ActualSchema = z.union([text, z.number()]);
export const ProductionRecordViewSchema = z
  .strictObject({
    productionRecordId: IdSchema,
    kind: ProductionKindSchema,
    orderItemId: orNull(IdSchema),
    adId: orNull(IdSchema),
    episodeNo: orNull(z.int().positive()),
    variant: z.enum(["common", "douyin", "wechat_channels"]),
    source: z.enum(["manual_upload", "normalized", "restamped", "render", "ai_assisted"]),
    derivedFromFileId: orNull(IdSchema),
    productionTier: orNull(z.enum(["standard", "advanced", "top"])),
    master: orNull(
      z.strictObject({
        dramaEpisodeMasterId: IdSchema,
        revNo: z.int().positive(),
        masterSource: text,
      }),
    ),
    headAdVersionId: orNull(IdSchema),
    tailAdVersionId: orNull(IdSchema),
    aiUsage: BatchAiUsageSchema,
    aigcState: z.enum(["not_required", "pending", "verified", "failed"]),
    aigcOrigin: orNull(z.enum(["upstream", "stamped"])),
    aigcMeta: orNull(
      z.strictObject({
        Label: text,
        ContentProducer: text,
        ProduceID: text,
        ReservedCode1: text,
        ContentPropagator: text,
        PropagateID: text,
        ReservedCode2: text,
      }),
    ),
    pipelineState: PipelineStateSchema,
    check: orNull(
      z.strictObject({
        profile: text,
        ruleVersion: z.int().positive(),
        gate: z.enum(["pass", "reject"]),
        hard: z.array(
          z.strictObject({
            code: text,
            pass: z.boolean(),
            actual: ActualSchema,
            expected: ActualSchema,
          }),
        ),
        soft: z.array(
          z.strictObject({ code: text, level: text, actual: ActualSchema, note: text }),
        ),
        checkedAt: InstantSchema,
      }),
    ),
    media: orNull(
      z.strictObject({
        durationMs: orNull(n),
        width: orNull(n),
        height: orNull(n),
        displayWidth: orNull(n),
        displayHeight: orNull(n),
        vcodec: orNull(text),
        acodec: orNull(text),
        bitrateKbps: orNull(n),
        isFaststart: orNull(z.boolean()),
      }),
    ),
    uploadedBy: orNull(StaffBriefSchema),
    createdAt: InstantSchema,
    actions: z.array(z.enum(["normalize", "restamp", "recheck"])),
  })
  .openapi("ProductionRecordView");
export const ProductionRecordPageSchema = adminPage(ProductionRecordViewSchema).openapi(
  "ProductionRecordPage",
);
export const ProductionJobAcceptedSchema = z
  .strictObject({
    sourceFileId: IdSchema,
    productionRecordId: IdSchema,
    pipelineState: z.enum(["uploading", "checking"]),
    mediaJobId: IdSchema,
    jobKind: z.enum(["normalize", "restamp", "probe"]),
    jobState: z.enum([
      "queued",
      "running",
      "submitting",
      "submitted",
      "succeeded",
      "failed",
      "canceled",
    ]),
  })
  .openapi("ProductionJobAccepted");
export const MaterialListSchema = z
  .strictObject({
    masters: z.array(
      z.strictObject({
        episodeNo: z.int().positive(),
        dramaEpisodeMasterId: IdSchema,
        revNo: z.int().positive(),
        durationMs: orNull(n),
        sizeBytes: text,
        myLastCheckout: orNull(
          z.strictObject({
            checkedOutAt: InstantSchema,
            checkoutCount: z.int().positive(),
            dramaEpisodeMasterId: IdSchema,
          }),
        ),
      }),
    ),
    ads: z.array(
      z.strictObject({
        slot: text,
        adId: IdSchema,
        adNo: text,
        adVersionId: IdSchema,
        versionNo: z.int().positive(),
        durationMs: orNull(n),
        copy: orNull(text),
      }),
    ),
    storeAssets: z.array(
      z.strictObject({
        storeAssetId: IdSchema,
        type: text,
        title: orNull(text),
        usability: orNull(text),
      }),
    ),
    profileMedia: z.array(OrderReferenceFileSchema),
    profileText: z.strictObject({
      brandName: orNull(text),
      brandIntro: orNull(text),
      promoText: orNull(text),
      groupBuyText: orNull(text),
      sellingNote: orNull(text),
      bannedTerms: orNull(text),
    }),
  })
  .openapi("MaterialList");
export const MaterialDownloadBodySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("master"),
      episodeNos: z.array(z.int().positive()).min(1).max(50).refine(unique),
    }),
    z.strictObject({ kind: z.literal("ad_version"), adVersionId: IdSchema }),
    z.strictObject({ kind: z.literal("store_asset"), storeAssetId: IdSchema }),
    z.strictObject({ kind: z.literal("profile_media"), fileId: IdSchema }),
  ])
  .openapi("MaterialDownloadBody");
export const MaterialDownloadResultSchema = z
  .strictObject({
    items: z.array(
      z.strictObject({
        kind: z.enum(["master", "ad_version", "store_asset", "profile_media"]),
        episodeNo: orNull(z.int().positive()),
        fileId: IdSchema,
        fileName: text,
        sizeBytes: text,
        url: z.url(),
        expiresAt: InstantSchema,
      }),
    ),
  })
  .openapi("MaterialDownloadResult");
export const DownloadRecordQuerySchema = PageQuerySchema.extend({
  kind: z.enum(["episode", "zip", "publish_list"]).optional(),
  episodeNo: z.coerce.number().int().positive().optional(),
}).openapi("DownloadRecordQuery");
export const DownloadRecordSchema = z
  .strictObject({
    downloadId: IdSchema,
    deliveryReleaseId: IdSchema,
    kind: z.enum(["episode", "zip", "publish_list"]),
    episodeNo: orNull(z.int().positive()),
    actorType: text,
    actorName: orNull(text),
    client: text,
    urlTtlSec: n,
    clientAck: orNull(z.enum(["saved", "failed"])),
    clientAckAt: at,
    createdAt: InstantSchema,
  })
  .openapi("DownloadRecord");
export const DownloadHistorySchema = z
  .strictObject({
    releases: z.array(ReleaseAdminViewSchema),
    grants: z.array(
      z.strictObject({
        downloadGrantId: IdSchema,
        deliveryReleaseId: IdSchema,
        state: text,
        expiresAt: InstantSchema,
        isExpired: z.boolean(),
        validDays: z.int().positive(),
        actorType: text,
        client: orNull(text),
        revokeReason: orNull(text),
        endedAt: at,
        createdAt: InstantSchema,
      }),
    ),
    logs: adminPage(DownloadRecordSchema),
  })
  .openapi("DownloadHistory");
export type ProductionRecordQuery = z.infer<typeof ProductionRecordQuerySchema>;
export type NormalizeBody = z.infer<typeof NormalizeBodySchema>;
export type RestampBody = z.infer<typeof RestampBodySchema>;
export type RecheckBody = z.infer<typeof RecheckBodySchema>;
export type ProductionRecordView = z.infer<typeof ProductionRecordViewSchema>;
export type ProductionJobAccepted = z.infer<typeof ProductionJobAcceptedSchema>;
export type MaterialList = z.infer<typeof MaterialListSchema>;
export type MaterialDownloadBody = z.infer<typeof MaterialDownloadBodySchema>;
export type MaterialDownloadResult = z.infer<typeof MaterialDownloadResultSchema>;
export type DownloadRecordQuery = z.infer<typeof DownloadRecordQuerySchema>;
export type DownloadRecord = z.infer<typeof DownloadRecordSchema>;
export type DownloadHistory = z.infer<typeof DownloadHistorySchema>;
