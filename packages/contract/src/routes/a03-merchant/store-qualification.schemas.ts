import { z } from "../../zod.js";
import { IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";
import { ENTITY_TYPE, QUALIFICATION_STATUS } from "../../enums/index.js";
import { ApprovalDecisionViewSchema } from "../a01-system/approvals.schemas.js";
import { QualificationRecordSchema } from "../m03-profile-asset/qualification.schemas.js";
import { MerchantUserBriefSchema } from "./entities.schemas.js";
import {
  AdminQualificationDocSchema,
  QualificationSubmissionDetailSchema,
} from "./qualification.schemas.js";

export const QualificationRoundRecordSchema = QualificationRecordSchema.omit({
  decidedAt: true,
  isDecidedBySystem: true,
  rejectReasons: true,
  decisionNote: true,
})
  .extend({
    submittedBy: MerchantUserBriefSchema,
    approval: ApprovalDecisionViewSchema,
    approveMode: QualificationSubmissionDetailSchema.shape.approveMode,
  })
  .openapi("QualificationRoundRecord");

export const AdminStoreQualificationViewSchema = z
  .object({
    storeId: IdSchema,
    qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
    isChangeInReview: z.boolean(),
    isFinalRejected: z.boolean(),
    firstSubmittedAt: orNull(InstantSchema),
    firstVerifiedAt: orNull(InstantSchema),
    lastDecidedAt: orNull(InstantSchema),
    entity: z.object({
      entityId: IdSchema,
      name: orNull(z.string()),
      entityType: orNull(openEnum(ENTITY_TYPE.values)),
      verificationStatus: openEnum(QUALIFICATION_STATUS.values),
      usccMask: orNull(z.string()),
      legalRepNameMask: orNull(z.string()),
      verifiedAt: orNull(InstantSchema),
    }),
    effectiveDocs: z.array(AdminQualificationDocSchema),
    openRound: orNull(
      z.object({
        qualificationSubmissionId: IdSchema,
        kind: QualificationRecordSchema.shape.kind,
        roundNo: z.int().min(1),
        submittedAt: InstantSchema,
        dueAt: orNull(InstantSchema),
      }),
    ),
    rounds: z.array(QualificationRoundRecordSchema),
  })
  .openapi("AdminStoreQualificationView");
export type AdminStoreQualificationView = z.infer<typeof AdminStoreQualificationViewSchema>;
