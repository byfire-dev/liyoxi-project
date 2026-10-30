import { z } from "../../zod.js";
import { IdSchema, InstantSchema, CursorQuerySchema } from "../../common/index.js";
import {
  LICENSE_LETTER_STATUS,
  LICENSE_LETTER_VOID_REASON,
  LICENSE_LETTER_REVISION_REASON,
  LICENSE_LETTER_REVISION_RENDER_STATUS,
  LICENSE_LETTER_REVISION_SIGN_MODE,
} from "../../enums/docs.js";

const queryBool = z.stringbool({ truthy: ["true"], falsy: ["false"] }).openapi({ type: "boolean" });
const platform = z.enum(["douyin", "wechat_channels"]);
const signMode = z.enum(LICENSE_LETTER_REVISION_SIGN_MODE.values);
const date = z.iso.date();
const n = z.int().nonnegative();
export const LicenseLetterParamSchema = z.strictObject({ licenseLetterId: IdSchema });
export const LicenseLetterRevisionParamSchema = z.strictObject({
  licenseLetterRevisionId: IdSchema,
});
export const LicenseLetterFilterSchema = z.strictObject({
  orderId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  includeVoided: queryBool.default(false),
});
export const LicenseLetterQuerySchema = LicenseLetterFilterSchema.extend(CursorQuerySchema.shape);
export const AdminLicenseLetterQuerySchema = z.strictObject({
  includeVoided: queryBool.default(true),
});
export const LicenseRenderIssueSchema = z
  .strictObject({
    kind: z.literal("missing_glyph"),
    missing: z
      .array(
        z.strictObject({
          character: z.string().min(1).max(2),
          codePoint: z.string().regex(/^U\+[0-9A-F]{4,6}$/),
          fields: z.array(z.string().min(1).max(128)).min(1).max(4),
        }),
      )
      .min(1)
      .max(32),
    totalMissingCodePoints: z.int().positive(),
    truncated: z.boolean(),
  })
  .openapi("LicenseRenderIssue");
export const LicenseLetterCardSchema = z
  .strictObject({
    licenseLetterId: IdSchema,
    letterNo: z.string(),
    orderId: IdSchema,
    orderNo: z.string(),
    orderItemId: IdSchema,
    storeId: IdSchema,
    dramaTitle: z.string(),
    episodeCount: z.int().positive(),
    platform,
    accountName: z.string(),
    status: z.enum(LICENSE_LETTER_STATUS.values),
    displayStatus: z.enum(["pending_effective", "effective", "expired", "voided"]),
    periodStartDate: date.nullable(),
    periodEndDate: date,
    createdAt: InstantSchema,
    currentRevNo: z.int().positive().nullable(),
    issuedAt: InstantSchema.nullable(),
    isRendering: z.boolean(),
    voidReason: z.enum(LICENSE_LETTER_VOID_REASON.values).nullable(),
    voidedAt: InstantSchema.nullable(),
    canDownload: z.boolean(),
    renderIssue: LicenseRenderIssueSchema.nullable(),
  })
  .openapi("LicenseLetterCard");
export const LicenseLetterPreviewSchema = z
  .strictObject({
    licensorName: z.string(),
    licensorCreditCodeMask: z.string(),
    licenseeName: z.string(),
    licenseeCreditCodeMask: z.string(),
    storeName: z.string(),
    dramaName: z.string(),
    episodes: z.int().positive(),
    permits: z.array(
      z.strictObject({ kind: z.string(), number: z.string(), platform: z.string() }),
    ),
    account: z.strictObject({ platform, name: z.string(), accountId: z.string() }),
    period: z.strictObject({
      startDate: date.nullable(),
      startText: z.string(),
      endDate: date,
      territory: z.string(),
    }),
    clauses: z.array(z.strictObject({ key: z.string(), title: z.string(), text: z.string() })),
    consent: z.strictObject({
      consentNo: z.string(),
      agreementName: z.string(),
      consentedAt: InstantSchema,
      operatorMask: z.string(),
    }),
    revNo: z.int().positive(),
    issuedAt: InstantSchema,
    verifyUrl: z.url(),
    contentFp: z.string().regex(/^[0-9a-f]{64}$/),
    signMode,
  })
  .openapi("LicenseLetterPreview");
export const LicenseLetterDetailSchema = LicenseLetterCardSchema.extend({
  preview: LicenseLetterPreviewSchema.nullable(),
  revisions: z.array(
    z.strictObject({
      revNo: z.int().positive(),
      reason: z.enum(LICENSE_LETTER_REVISION_REASON.values),
      issuedAt: InstantSchema,
    }),
  ),
}).openapi("LicenseLetterDetail");
export const LicenseLetterPageSchema = z
  .strictObject({
    items: z.array(LicenseLetterCardSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .openapi("LicenseLetterPage");
export const LicenseLetterSummarySchema = z
  .strictObject({ all: n, effective: n })
  .openapi("LicenseLetterSummary");
export const LicenseLetterDownloadBodySchema = z
  .strictObject({ revNo: z.int().positive().optional() })
  .openapi("LicenseLetterDownloadBody");
export const LicenseLetterDownloadUrlSchema = z
  .strictObject({
    url: z.url(),
    expiresAt: InstantSchema,
    fileName: z.string(),
    revNo: z.int().positive(),
  })
  .openapi("LicenseLetterDownloadUrl");
export const LicenseLetterCorrectBodySchema = z
  .strictObject({
    correctionKinds: z
      .array(z.enum(["licensee_name", "store_name", "account_name", "other"]))
      .min(1),
    note: z.string().trim().min(1).max(200),
  })
  .openapi("LicenseLetterCorrectBody");
export const LicenseLetterVoidBodySchema = z
  .strictObject({ note: z.string().trim().min(1).max(200) })
  .openapi("LicenseLetterVoidBody");
export const LicenseLetterRerenderBodySchema = z
  .strictObject({})
  .openapi("LicenseLetterRerenderBody");
export const LicenseLetterRevisionViewSchema = z
  .strictObject({
    licenseLetterRevisionId: IdSchema,
    revNo: z.int().positive(),
    reason: z.enum(LICENSE_LETTER_REVISION_REASON.values),
    renderStatus: z.enum(LICENSE_LETTER_REVISION_RENDER_STATUS.values),
    renderAttemptNo: n,
    fileId: IdSchema.nullable(),
    contentFp: z.string().regex(/^[0-9a-f]{64}$/),
    templateVersion: z.string(),
    signMode: signMode.nullable(),
    platformSignedAt: InstantSchema.nullable(),
    readyAt: InstantSchema.nullable(),
    createdAt: InstantSchema,
    actions: z.array(z.enum(["rerender"])),
    renderIssue: LicenseRenderIssueSchema.nullable(),
  })
  .openapi("LicenseLetterRevisionView");
export const AdminLicenseLetterViewSchema = z
  .strictObject({
    licenseLetterId: IdSchema,
    letterNo: z.string(),
    orderItemId: IdSchema,
    channelAccountId: IdSchema,
    platform,
    accountName: z.string(),
    status: z.enum(LICENSE_LETTER_STATUS.values),
    isExpired: z.boolean(),
    periodStart: date.nullable(),
    periodEnd: date,
    voidReason: z.enum(LICENSE_LETTER_VOID_REASON.values).nullable(),
    voidedAt: InstantSchema.nullable(),
    createdAt: InstantSchema,
    currentRevision: LicenseLetterRevisionViewSchema.nullable(),
    revisions: z.array(LicenseLetterRevisionViewSchema),
    actions: z.array(z.enum(["correct", "void"])),
  })
  .openapi("AdminLicenseLetterView");
export const LicenseLetterListSchema = z
  .strictObject({ items: z.array(AdminLicenseLetterViewSchema) })
  .openapi("LicenseLetterList");
export const LicenseLetterVoidResultSchema = z
  .strictObject({
    voided: AdminLicenseLetterViewSchema,
    reissued: AdminLicenseLetterViewSchema.nullable(),
  })
  .openapi("LicenseLetterVoidResult");
export type LicenseRenderIssue = z.infer<typeof LicenseRenderIssueSchema>;
export type LicenseLetterCard = z.infer<typeof LicenseLetterCardSchema>;
export type LicenseLetterDetail = z.infer<typeof LicenseLetterDetailSchema>;
export type LicenseLetterPreview = z.infer<typeof LicenseLetterPreviewSchema>;
export type LicenseLetterQuery = z.infer<typeof LicenseLetterQuerySchema>;
export type LicenseLetterFilter = z.infer<typeof LicenseLetterFilterSchema>;
export type LicenseLetterDownloadBody = z.infer<typeof LicenseLetterDownloadBodySchema>;
export type LicenseLetterDownloadUrl = z.infer<typeof LicenseLetterDownloadUrlSchema>;
export type LicenseLetterCorrectBody = z.infer<typeof LicenseLetterCorrectBodySchema>;
export type LicenseLetterVoidBody = z.infer<typeof LicenseLetterVoidBodySchema>;
export type LicenseLetterRevisionView = z.infer<typeof LicenseLetterRevisionViewSchema>;
export type AdminLicenseLetterView = z.infer<typeof AdminLicenseLetterViewSchema>;
