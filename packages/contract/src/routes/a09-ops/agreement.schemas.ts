// W2-12：协议管理的八个接口只在这里定义本域结构；M1 同意记录仍只追加。
import { IdSchema, InstantSchema, PageQuerySchema, openEnum, orNull } from "../../common/index.js";
import {
  AGREEMENT_CONSENT_BIZ_TYPE,
  AGREEMENT_CONSENT_METHOD,
  AGREEMENT_CONSENT_MODE,
  AGREEMENT_CONSENT_SCENE,
  AGREEMENT_SUBJECT_KIND,
  AGREEMENT_VERSION_STATUS,
  MERCHANT_ROLE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
import { SiteNoticeItemSchema } from "./site.schemas.js";
import { AgreementKeySchema, ConsentSceneSchema } from "../m01-account/agreement.schemas.js";
const status = openEnum(AGREEMENT_VERSION_STATUS.values);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const AdminAgreementVersionBriefSchema = z
  .strictObject({
    agreementVersionId: IdSchema,
    versionLabel: z.string(),
    effectiveAt: orNull(InstantSchema),
  })
  .openapi("AdminAgreementVersionBrief");
export const AgreementListItemSchema = z
  .strictObject({
    agreementKey: AgreementKeySchema,
    name: z.string(),
    subjectKind: openEnum(AGREEMENT_SUBJECT_KIND.values),
    consentMode: openEnum(AGREEMENT_CONSENT_MODE.values),
    scenes: z.array(openEnum(AGREEMENT_CONSENT_SCENE.values)),
    signSceneLabel: z.string(),
    audienceLabel: z.string(),
    sinceVersion: z.string(),
    currentVersion: orNull(AdminAgreementVersionBriefSchema),
    pendingVersion: orNull(AdminAgreementVersionBriefSchema),
    draftVersion: orNull(AdminAgreementVersionBriefSchema),
  })
  .openapi("AgreementListItem");
export const AgreementFileBriefSchema = z
  .strictObject({
    fileId: IdSchema,
    originalName: z.string().nullable(),
    sizeBytes: z.string().regex(/^\d+$/).nullable(),
    mime: z.string().nullable(),
  })
  .openapi("AgreementFileBrief");
export const AgreementVersionItemSchema = z
  .strictObject({
    agreementVersionId: IdSchema,
    agreementKey: AgreementKeySchema,
    major: z.int(),
    minor: z.int(),
    versionLabel: z.string(),
    status,
    displayStatus: status,
    effectiveAt: orNull(InstantSchema),
    summary: orNull(z.string()),
    isReconsentRequired: z.boolean(),
    isLegalApproved: z.boolean(),
    sourceFile: orNull(AgreementFileBriefSchema),
    pdfFile: orNull(AgreementFileBriefSchema),
    hasContentHtml: z.boolean(),
    contentSha256: orNull(hash),
    siteNoticeId: orNull(IdSchema),
    shortNoticeReason: orNull(z.string()),
    expectedConsents: orNull(z.int().nonnegative()),
    activatedAt: orNull(InstantSchema),
    createdBy: StaffBriefSchema,
    publishedBy: orNull(StaffBriefSchema),
    lockVersion: z.int().nonnegative(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    actions: z.array(z.enum(["edit", "schedule", "withdraw"])),
  })
  .openapi("AgreementVersionItem");
export const AgreementDetailSchema = AgreementListItemSchema.extend({
  versions: z.array(AgreementVersionItemSchema),
  currentContentHtml: orNull(z.string()),
  draftContentHtml: orNull(z.string()),
  reconsentProgress: orNull(
    z.strictObject({
      agreementVersionId: IdSchema,
      versionLabel: z.string(),
      consentedCount: z.int().nonnegative(),
      expectedCount: z.int().nonnegative(),
      ratioBp: z.int().min(0).max(10000),
    }),
  ),
}).openapi("AgreementDetail");
export const AdminAgreementListQuerySchema =
  PageQuerySchema.strict().openapi("AdminAgreementListQuery");
export const AdminAgreementListSchema = adminPage(AgreementListItemSchema);
export const AgreementKeyParamsSchema = z.strictObject({ agreementKey: AgreementKeySchema });
export const AdminAgreementVersionParamsSchema = z.strictObject({ agreementVersionId: IdSchema });
const draft = {
  effectiveAt: InstantSchema.optional(),
  summary: z.string().trim().min(1).max(60).optional(),
  sourceFileId: IdSchema.optional(),
  pdfFileId: IdSchema.optional(),
  isReconsentRequired: z.boolean().optional(),
  isLegalApproved: z.boolean().optional(),
};
export const AgreementVersionCreateBodySchema = z
  .strictObject({ ...draft, bumpMajor: z.boolean().default(false) })
  .openapi("AgreementVersionCreateBody");
export const AgreementVersionUpdateBodySchema = z
  .strictObject({
    ...draft,
    effectiveAt: orNull(InstantSchema).optional(),
    summary: z.string().trim().min(1).max(60).nullable().optional(),
    sourceFileId: IdSchema.nullable().optional(),
    pdfFileId: IdSchema.nullable().optional(),
    lockVersion: z.int().nonnegative(),
  })
  .openapi("AgreementVersionUpdateBody");
export const AgreementVersionScheduleBodySchema = z
  .strictObject({
    lockVersion: z.int().nonnegative(),
    shortNoticeReason: z.string().trim().min(1).max(100).optional(),
  })
  .openapi("AgreementVersionScheduleBody");
export const AgreementVersionWithdrawBodySchema = z
  .strictObject({ reason: z.string().max(100).optional() })
  .openapi("AgreementVersionWithdrawBody");
export const ContentConversionSchema = z
  .strictObject({
    state: z.enum(["converted", "pdf_only", "unchanged"]),
    warnings: z.array(
      z.strictObject({ code: z.literal("text_mismatch"), similarityBp: z.int().min(0).max(10000) }),
    ),
  })
  .openapi("ContentConversion");
export const AgreementVersionMutationResultSchema = z
  .strictObject({
    version: AgreementVersionItemSchema,
    contentHtml: orNull(z.string()),
    conversion: ContentConversionSchema,
  })
  .openapi("AgreementVersionMutationResult");
export const AgreementSiteNoticeSchema = SiteNoticeItemSchema;
export const AgreementVersionScheduleResultSchema = z.strictObject({
  version: AgreementVersionItemSchema,
  siteNotice: orNull(AgreementSiteNoticeSchema),
});
export const AgreementVersionWithdrawResultSchema = z.strictObject({
  withdrawn: AgreementVersionItemSchema,
  newDraft: orNull(AgreementVersionItemSchema),
  siteNotice: orNull(AgreementSiteNoticeSchema),
});
export const AgreementConsentItemSchema = z
  .strictObject({
    agreementConsentId: IdSchema,
    consentNo: z.string().regex(/^\d+$/),
    agreementKey: AgreementKeySchema,
    agreementName: z.string(),
    agreementVersionId: IdSchema,
    versionLabel: z.string(),
    scene: openEnum(AGREEMENT_CONSENT_SCENE.values),
    method: openEnum(AGREEMENT_CONSENT_METHOD.values),
    merchantUserId: IdSchema,
    phoneMask: z.string(),
    operatorNameMask: orNull(z.string()),
    role: orNull(openEnum(MERCHANT_ROLE.values)),
    entityId: orNull(IdSchema),
    entityName: orNull(z.string()),
    usccMask: orNull(z.string()),
    storeId: orNull(IdSchema),
    storeName: orNull(z.string()),
    bizType: orNull(openEnum(AGREEMENT_CONSENT_BIZ_TYPE.values)),
    bizId: orNull(IdSchema),
    bizNo: orNull(z.string()),
    consentedAt: InstantSchema,
  })
  .openapi("AgreementConsentItem");
export const AgreementConsentDetailSchema = AgreementConsentItemSchema.extend({
  contentSha256: hash,
  isContentHashConsistent: z.boolean(),
  appid: orNull(z.string()),
  hasOpenidSnapshot: z.boolean(),
  ipMask: z.string(),
  userAgent: orNull(z.string()),
  device: z.strictObject({
    model: z.string().optional(),
    system: z.string().optional(),
    wechatVersion: z.string().optional(),
    sdkVersion: z.string().optional(),
    appVersion: z.string().optional(),
  }),
  requestId: z.string(),
  revealableFields: z.array(z.enum(["phone", "uscc"])),
  createdAt: InstantSchema,
}).openapi("AgreementConsentDetail");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    "日期无效",
  );
export const AdminAgreementConsentListQuerySchema = PageQuerySchema.extend({
  agreementKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*){0,6}$/)
    .optional(),
  agreementVersionId: IdSchema.optional(),
  merchantUserId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  scene: z.string().optional(),
  method: z.enum(["checkbox", "by_action", "prior_consent"]).optional(),
  bizType: z.enum(["billing_order", "drama_order", "ad"]).optional(),
  bizId: IdSchema.optional(),
  no: z.string().max(40).optional(),
  consentNo: z
    .string()
    .regex(/^\d{1,19}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n, "编号超出范围")
    .optional(),
  consentedFrom: date.optional(),
  consentedTo: date.optional(),
  sort: z.enum(["-consentedAt", "consentedAt"]).default("-consentedAt"),
})
  .strict()
  .superRefine((v, c) => {
    if (v.bizId && !v.bizType)
      c.addIssue({ code: "custom", path: ["bizType"], message: "单据id须同时给单据类型" });
    if (v.scene && v.scene.split(",").some((s) => !ConsentSceneSchema.safeParse(s).success))
      c.addIssue({ code: "custom", path: ["scene"], message: "签署场景无效" });
    if (
      v.consentedFrom &&
      v.consentedTo &&
      (v.consentedFrom > v.consentedTo ||
        Date.parse(v.consentedTo) - Date.parse(v.consentedFrom) > 365 * 86400000)
    )
      c.addIssue({ code: "custom", path: ["consentedTo"], message: "日期范围须为正序且至多366天" });
  })
  .openapi("AdminAgreementConsentListQuery");
export const AdminAgreementConsentListSchema = adminPage(AgreementConsentItemSchema);
export const AgreementConsentParamsSchema = z.strictObject({ agreementConsentId: IdSchema });
export type AgreementVersionItem = z.infer<typeof AgreementVersionItemSchema>;
export type AgreementListItem = z.infer<typeof AgreementListItemSchema>;
export type AgreementDetail = z.infer<typeof AgreementDetailSchema>;
export type AgreementVersionCreateBody = z.infer<typeof AgreementVersionCreateBodySchema>;
export type AgreementVersionUpdateBody = z.infer<typeof AgreementVersionUpdateBodySchema>;
export type AgreementVersionScheduleBody = z.infer<typeof AgreementVersionScheduleBodySchema>;
export type AgreementVersionWithdrawBody = z.infer<typeof AgreementVersionWithdrawBodySchema>;
export type AgreementVersionMutationResult = z.infer<typeof AgreementVersionMutationResultSchema>;
export type AgreementSiteNotice = z.infer<typeof AgreementSiteNoticeSchema>;
export type AgreementConsentItem = z.infer<typeof AgreementConsentItemSchema>;
export type AgreementConsentDetail = z.infer<typeof AgreementConsentDetailSchema>;
export type AdminAgreementConsentListQuery = z.infer<typeof AdminAgreementConsentListQuerySchema>;
