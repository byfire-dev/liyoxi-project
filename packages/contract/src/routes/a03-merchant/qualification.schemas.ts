import {
  QUALIFICATION_SUBMISSION_KIND,
  QUALIFICATION_SUBMISSION_OUTCOME,
  QUALIFICATION_SUBMISSION_APPROVE_MODE,
  QUALIFICATION_SUBMISSION_SYSTEM_REJECT_CODE,
  ENTITY_TYPE,
  QUALIFICATION_STATUS,
  STORE_PROFILE_CONTACT_PHONE_SOURCE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { DictRefSchema, IdSchema, InstantSchema, orNull, openEnum } from "../../common/index.js";
import { ApprovalDecisionViewSchema } from "../a01-system/approvals.schemas.js";
import { QualificationDocSchema } from "../m03-profile-asset/qualification.schemas.js";
import { PendingChangeSchema } from "../m03-profile-asset/profile.schemas.js";
import { StoreRegionSchema } from "./stores.schemas.js";
export const AdminQualificationDocSchema = QualificationDocSchema.omit({ hasSubmittedFields: true })
  .extend({
    fieldChecks: z.array(
      z.object({
        code: z.string(),
        field: z.string(),
        result: openEnum(["pass", "fail", "warn", "manual", "info"]),
      }),
    ),
    isCorrected: z.boolean(),
  })
  .openapi("AdminQualificationDoc");
export const QualificationSubmissionDetailSchema = z
  .object({
    qualificationSubmissionId: IdSchema,
    kind: openEnum(QUALIFICATION_SUBMISSION_KIND.values),
    roundNo: orNull(z.int().min(1)),
    isResubmit: z.boolean(),
    claimedEntityType: orNull(openEnum(ENTITY_TYPE.values)),
    approval: ApprovalDecisionViewSchema,
    confirmChecks: z.array(z.string()),
    lockVersion: z.int().min(0),
    closedAt: orNull(InstantSchema),
    outcome: orNull(openEnum(QUALIFICATION_SUBMISSION_OUTCOME.values)),
    approveMode: orNull(openEnum(QUALIFICATION_SUBMISSION_APPROVE_MODE.values)),
    systemRejectCode: orNull(openEnum(QUALIFICATION_SUBMISSION_SYSTEM_REJECT_CODE.values)),
    finalRejectedAt: orNull(InstantSchema),
    store: z.object({
      storeId: IdSchema,
      name: orNull(z.string()),
      isPrimary: z.boolean(),
      qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
      industry: orNull(DictRefSchema),
      category: orNull(DictRefSchema),
      region: StoreRegionSchema,
    }),
    entity: z.object({
      entityId: IdSchema,
      name: orNull(z.string()),
      verificationStatus: openEnum(QUALIFICATION_STATUS.values),
      usccMask: orNull(z.string()),
      verifiedAt: orNull(InstantSchema),
      verifiedStores: z.array(z.object({ storeId: IdSchema, name: orNull(z.string()) })),
    }),
    proposed: orNull(PendingChangeSchema),
    changedFields: z.array(z.string()),
    contact: orNull(
      z.object({
        name: orNull(z.string()),
        phoneMask: orNull(z.string()),
        phoneVerifyState: orNull(openEnum(STORE_PROFILE_CONTACT_PHONE_SOURCE.values)),
      }),
    ),
    profileDigest: z.object({
      completenessPct: z.int().min(0).max(100),
      doorCount: z.int().min(0),
      interiorCount: z.int().min(0),
      serviceItemCount: z.int().min(0),
    }),
    checkSummary: orNull(
      z.object({
        fail: z.int().min(0),
        warn: z.int().min(0),
        manual: z.int().min(0),
        suggestedReason: orNull(DictRefSchema),
        suggestedNote: orNull(z.string()),
      }),
    ),
    checksRanAt: orNull(InstantSchema),
    docs: z.array(AdminQualificationDocSchema),
    referenceDocs: z.array(AdminQualificationDocSchema),
    duplicateUscc: z.object({
      inReviewElsewhereCount: z.int().min(0),
      isVerifiedElsewhere: z.boolean(),
    }),
    relatedOrders: z.array(
      z.object({
        kind: z.enum(["payment_order", "drama_order"]),
        id: IdSchema,
        no: z.string(),
        title: z.string(),
        statusText: z.string(),
        amountFen: orNull(z.int().min(0)),
        heldPoints: orNull(z.int().min(0)),
      }),
    ),
    canOverride: z.boolean(),
    actions: z.array(z.string()),
  })
  .openapi("QualificationSubmissionDetail");
export const QualificationSubmissionParamsSchema = z.object({
  qualificationSubmissionId: IdSchema,
});
// 缺少回显由领域守卫返回 CONFIRM_MISMATCH；置于范围、待审与版本检查之后。
const confirm = z.object({ roundNo: z.int().optional() }).optional();
export const QualificationApproveBodySchema = z.object({
  lockVersion: z.int().min(0),
  mode: z.enum(["normal", "override"]).default("normal"),
  overrideReason: z.string().min(10).max(200).optional(),
  confirm,
  confirmChecks: z.array(z.string()).max(10).optional(),
});
export const QualificationRejectBodySchema = z.object({
  reasonCodes: z
    .array(z.string())
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length),
  note: z.string().trim().min(1).max(200),
  rejectedDocIds: z
    .array(IdSchema)
    .refine((v) => new Set(v).size === v.length)
    .optional(),
  isFinal: z.boolean().default(false),
  confirm,
});
export type QualificationApproveBody = z.infer<typeof QualificationApproveBodySchema>;
export type QualificationRejectBody = z.infer<typeof QualificationRejectBodySchema>;
export type QualificationSubmissionDetail = z.infer<typeof QualificationSubmissionDetailSchema>;
