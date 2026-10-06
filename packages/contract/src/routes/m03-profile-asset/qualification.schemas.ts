import { z } from "../../zod.js";
import {
  DateSchema,
  DictRefSchema,
  IdSchema,
  InstantSchema,
  openEnum,
} from "../../common/index.js";
import {
  QUALIFICATION_DOC_DOC_TYPE,
  QUALIFICATION_DOC_SCOPE,
  QUALIFICATION_DOC_ORIGIN,
  QUALIFICATION_DOC_PRINCIPAL_ROLE,
  QUALIFICATION_DOC_SUBJECT_TYPE,
  QUALIFICATION_DOC_VERDICT,
  QUALIFICATION_SUBMISSION_KIND,
  QUALIFICATION_SUBMISSION_OUTCOME,
  QUALIFICATION_STATUS,
  STORE_PROFILE_CONTACT_PHONE_SOURCE,
} from "../../enums/index.js";

// 信息确认版本随发版；不是协议同意记录（m03 第 6 节默认 1）。
export const QUALIFICATION_DECLARATION_VERSION = "1";
export const QualificationDocSchema = z
  .object({
    qualificationDocId: IdSchema,
    docType: openEnum(QUALIFICATION_DOC_DOC_TYPE.values),
    permitType: DictRefSchema.nullable(),
    scope: openEnum(QUALIFICATION_DOC_SCOPE.values),
    origin: openEnum(QUALIFICATION_DOC_ORIGIN.values),
    fileId: IdSchema,
    ocrStatus: openEnum(["ok", "unavailable", "unreadable"]),
    ocrWarnings: z.array(z.string()),
    hasSubmittedFields: z.boolean(),
    holderName: z.string().nullable(),
    certNoMask: z.string().nullable(),
    principalNameMask: z.string().nullable(),
    principalRole: openEnum(QUALIFICATION_DOC_PRINCIPAL_ROLE.values).nullable(),
    subjectType: openEnum(QUALIFICATION_DOC_SUBJECT_TYPE.values).nullable(),
    validStartDate: DateSchema.nullable(),
    validEndDate: DateSchema.nullable(),
    isLongTerm: z.boolean(),
    expiryState: openEnum(["none", "expiring", "expired"]),
    displayFields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
    verdict: openEnum(QUALIFICATION_DOC_VERDICT.values).nullable(),
    isEffective: z.boolean(),
    uploadedAt: InstantSchema,
  })
  .openapi("QualificationDoc");
export const ContactViewSchema = z
  .object({
    name: z.string().nullable(),
    phoneMask: z.string().nullable(),
    phoneVerifyState: openEnum(STORE_PROFILE_CONTACT_PHONE_SOURCE.values).nullable(),
    phoneVerifiedAt: InstantSchema.nullable(),
    loginPhoneMask: z.string().nullable(),
    isSmsVerifyAvailable: z.boolean(),
    lockVersion: z.int(),
  })
  .openapi("ContactView");
export const QualificationRoundSchema = z
  .object({
    qualificationSubmissionId: IdSchema,
    kind: openEnum(QUALIFICATION_SUBMISSION_KIND.values),
    phase: openEnum(["draft", "in_review", "closed"]),
    roundNo: z.int().nullable(),
    isResubmit: z.boolean(),
    claimedEntityType: openEnum(["enterprise", "individual"]).nullable(),
    declarationConfirmedAt: InstantSchema.nullable(),
    declarationVersion: z.string().nullable(),
    changedFields: z.array(
      openEnum(["store_name", "address", "industry", "docs", "entity_license"]),
    ),
    proposed: z.null(),
    contactSnapshot: z
      .object({
        name: z.string(),
        phoneMask: z.string(),
        phoneVerifyState: openEnum(STORE_PROFILE_CONTACT_PHONE_SOURCE.values),
      })
      .nullable(),
    submittedAt: InstantSchema.nullable(),
    dueAt: InstantSchema.nullable(),
    closedAt: InstantSchema.nullable(),
    outcome: openEnum(QUALIFICATION_SUBMISSION_OUTCOME.values).nullable(),
    decidedAt: InstantSchema.nullable(),
    isDecidedBySystem: z.boolean(),
    rejectReasons: z.array(DictRefSchema),
    decisionNote: z.string().nullable(),
    systemRejectCode: openEnum(["duplicate_entity"]).nullable(),
    finalRejectedAt: InstantSchema.nullable(),
    docs: z.array(QualificationDocSchema),
    lockVersion: z.int(),
  })
  .openapi("QualificationRound");
const qualificationCommon = {
  storeQualificationStatus: openEnum(QUALIFICATION_STATUS.values),
  isChangeInReview: z.boolean(),
  isFinalRejected: z.boolean(),
};
export const QualificationViewClerkSchema = z.object({
  viewerRole: z.literal("clerk"),
  ...qualificationCommon,
});
export const QualificationViewOwnerSchema = z.object({
  viewerRole: z.literal("owner"),
  ...qualificationCommon,
  entity: z.object({
    verificationStatus: openEnum(QUALIFICATION_STATUS.values),
    name: z.string().nullable(),
    entityType: openEnum(["enterprise", "individual"]).nullable(),
    usccMask: z.string().nullable(),
    legalRepNameMask: z.string().nullable(),
    verifiedAt: InstantSchema.nullable(),
  }),
  openRound: QualificationRoundSchema.nullable(),
  lastClosedRound: QualificationRoundSchema.nullable(),
  effectiveDocs: z.array(QualificationDocSchema),
  requiredPermits: z.array(z.object({ permitType: DictRefSchema, isProvided: z.boolean() })),
  contact: ContactViewSchema,
  declaration: z.object({ currentVersion: z.string() }),
  actions: z.array(z.string()),
});
export const QualificationViewSchema = z
  .discriminatedUnion("viewerRole", [QualificationViewOwnerSchema, QualificationViewClerkSchema])
  .openapi("QualificationView");
export const QualificationDraftPatchSchema = z.object({
  lockVersion: z.int().min(0).nullable(),
  claimedEntityType: z.enum(["enterprise", "individual"]).nullable().optional(),
  declarationConfirmed: z.boolean().optional(),
  declarationVersion: z.string().optional(),
});
export const ContactPatchSchema = z
  .object({
    lockVersion: z.int().min(0),
    name: z.string().min(1).max(20),
    phoneSource: z.enum(["login", "input"]),
    phone: z
      .string()
      .regex(/^1\d{10}$/)
      .optional(),
    smsCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .refine((v) => v.phoneSource !== "input" || v.phone !== undefined, "输入手机号时须给 phone");
export const QualificationSubmitBodySchema = z.object({
  qualificationSubmissionId: IdSchema,
  declarationConfirmed: z.boolean(),
  declarationVersion: z.string(),
});
export const QualificationDocCreateBodySchema = z
  .object({
    fileId: IdSchema,
    docType: z.enum(QUALIFICATION_DOC_DOC_TYPE.values),
    permitType: z.string().optional(),
  })
  .refine(
    (v) => (v.docType === "industry_permit") === (v.permitType !== undefined),
    "只有许可证须给 permitType",
  );
// 字段键随证照/许可证字典决定，服务层按具体类型校验并合并；不用 passthrough 响应。
export const QualificationDocPatchSchema = z.object({
  lockVersion: z.int().min(0),
  fields: z.record(z.string(), z.string()),
});
export const QualificationDocRecognizedSchema = z
  .object({
    qualificationSubmissionId: IdSchema,
    lockVersion: z.int(),
    doc: QualificationDocSchema,
    recognized: z.record(z.string(), z.string()).nullable(),
    submitted: z.record(z.string(), z.string()).nullable(),
    entityTypeCheck: z
      .object({
        recognizedSubjectType: openEnum(QUALIFICATION_DOC_SUBJECT_TYPE.values).nullable(),
        claimedEntityType: openEnum(["enterprise", "individual"]).nullable(),
        isMismatch: z.boolean(),
      })
      .nullable(),
    replayed: z.boolean(),
  })
  .openapi("QualificationDocRecognized");
export const QualificationDocUpdateResultSchema = QualificationDocRecognizedSchema.pick({
  qualificationSubmissionId: true,
  lockVersion: true,
  doc: true,
});
export type QualificationDraftPatch = z.infer<typeof QualificationDraftPatchSchema>;
export type ContactPatch = z.infer<typeof ContactPatchSchema>;
export type QualificationSubmitBody = z.infer<typeof QualificationSubmitBodySchema>;
export type QualificationDocCreateBody = z.infer<typeof QualificationDocCreateBodySchema>;
export type QualificationDocPatch = z.infer<typeof QualificationDocPatchSchema>;
