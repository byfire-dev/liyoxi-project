import { IdSchema, InstantSchema, PageQuerySchema, openEnum, orNull } from "../../common/index.js";
import {
  ASSIGNMENT_HISTORY_SOURCE,
  ASSIGNMENT_HISTORY_SUBJECT_TYPE,
  ASSIGNMENT_POOL,
  STAFF_ROLE_KEY,
  STAFF_SESSION_AUTH_METHOD,
  STAFF_SESSION_REVOKE_REASON,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { StaffBriefSchema } from "./structures.js";

const count = z.int().nonnegative();
const queryBool = z.stringbool({ truthy: ["true"], falsy: ["false"] }).openapi({ type: "boolean" });
export const StaffIdParamsSchema = z.object({ staffId: IdSchema });
export const StaffUpdateBodySchema = z
  .strictObject({
    name: z.string().min(1).max(10).optional(),
    roleKey: z.enum(STAFF_ROLE_KEY.values).optional(),
    isLead: z.boolean().optional(),
    staffGroupId: IdSchema.optional(),
    displayName: z.string().max(10).nullable().optional(),
    servicePhone: z.string().max(20).nullable().optional(),
    wecomQrFileId: IdSchema.nullable().optional(),
    ackNoLead: z.boolean().default(false),
    lockVersion: count,
  })
  .openapi("StaffUpdateBody");
export const ActivationDeliveryBodySchema = z
  .strictObject({
    activationDelivery: z.enum(["sms", "manual"]).default("sms"),
  })
  .openapi("ActivationDeliveryBody");
export const StaffResetBodySchema = ActivationDeliveryBodySchema.extend({
  confirm: z.strictObject({ staffNo: z.int().positive() }),
  note: z.string().max(200).optional(),
}).openapi("StaffResetBody");
const withNote = (value: { reason: string; note?: string }, ctx: z.RefinementCtx) => {
  if (value.reason === "other" && !value.note?.trim())
    ctx.addIssue({ code: "custom", path: ["note"], message: "其他原因必须填写说明" });
};
export const StaffDisableBodySchema = z
  .strictObject({
    handoverToStaffId: IdSchema.optional(),
    reason: z.enum(["resigned", "reassigned", "long_leave", "other"]),
    note: z.string().max(200).optional(),
    confirm: z.strictObject({ staffNo: z.int().positive(), openWorkCount: count }),
  })
  .superRefine(withNote)
  .openapi("StaffDisableBody");
export const HandoverBodySchema = z
  .strictObject({
    handoverToStaffId: IdSchema,
    reason: z.enum(["reassigned", "long_leave", "other"]),
    note: z.string().max(200).optional(),
  })
  .superRefine(withNote)
  .openapi("HandoverBody");
export const StaffUnlockBodySchema = z
  .strictObject({
    bucket: z.enum(["trusted", "untrusted", "all"]).default("all"),
    note: z.string().max(200).optional(),
  })
  .openapi("StaffUnlockBody");
export const StaffWecomBindBodySchema = z
  .strictObject({
    wecomUserid: z.string().min(1).max(64),
    takeOver: z.boolean().default(false),
  })
  .openapi("StaffWecomBindBody");
export const StaffPoolMembershipReplaceBodySchema = z
  .strictObject({
    memberships: z
      .array(
        z.strictObject({
          pool: z.enum(ASSIGNMENT_POOL.values),
          cityCode: z.string().min(1).nullable().optional(),
        }),
      )
      .max(20),
    lockVersion: count,
  })
  .superRefine((v, ctx) => {
    const keys = v.memberships.map((m) => `${m.pool}:${m.cityCode ?? ""}`);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", path: ["memberships"], message: "分配池与城市不能重复" });
  })
  .openapi("StaffPoolMembershipReplaceBody");
export const StaffDutyBodySchema = z.strictObject({ onDuty: z.boolean() }).openapi("StaffDutyBody");
export const StaffSessionListQuerySchema = PageQuerySchema.extend({
  staffId: IdSchema.optional(),
  activeOnly: queryBool.default(true),
}).openapi("StaffSessionListQuery");
export const StaffSessionIdParamsSchema = z.object({ staffSessionId: IdSchema });
export const StaffSessionRevokeBodySchema = z.strictObject({
  reason: z.string().max(200).optional(),
});
export const StaffSessionViewSchema = z
  .strictObject({
    staffSessionId: IdSchema,
    staff: StaffBriefSchema,
    authMethod: openEnum(STAFF_SESSION_AUTH_METHOD.values),
    ipMask: orNull(z.string()),
    userAgent: orNull(z.string()),
    createdAt: InstantSchema,
    lastSeenAt: InstantSchema,
    idleExpiresAt: InstantSchema,
    absoluteExpiresAt: InstantSchema,
    revokedAt: orNull(InstantSchema),
    revokeReason: orNull(openEnum(STAFF_SESSION_REVOKE_REASON.values)),
    isCurrent: z.boolean(),
    actions: z.array(z.literal("revoke")),
  })
  .openapi("StaffSessionView");
export const StaffGroupListQuerySchema = z.object({
  roleKey: z.enum(STAFF_ROLE_KEY.values).optional(),
});
export const StaffGroupSummarySchema = z
  .strictObject({
    staffGroupId: IdSchema,
    name: z.string(),
    roleKey: openEnum(STAFF_ROLE_KEY.values),
    isDefault: z.boolean(),
    memberCount: count,
    activeLeadCount: count,
  })
  .openapi("StaffGroupSummary");
export const AssignmentPoolListQuerySchema = z.object({
  pool: z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v.split(",").every((p) => (ASSIGNMENT_POOL.values as readonly string[]).includes(p)),
      "未登记的分配池",
    ),
  cityCode: z.string().min(1).optional(),
  staffId: IdSchema.optional(),
  onDuty: queryBool.optional(),
});
export const OpenWorkCountSchema = z.strictObject({
  source: openEnum(ASSIGNMENT_HISTORY_SOURCE.values),
  subjectType: openEnum(ASSIGNMENT_HISTORY_SUBJECT_TYPE.values),
  count,
});
export const OpenWorkSummarySchema = z
  .strictObject({
    staff: StaffBriefSchema,
    total: count,
    bySource: z.array(
      OpenWorkCountSchema.extend({
        samples: z.array(z.strictObject({ subjectId: IdSchema, label: z.string() })).max(5),
      }),
    ),
    candidates: z.array(StaffBriefSchema),
    pendingApprovalsAsRequester: count,
  })
  .openapi("OpenWorkSummary");
export const StaffCountsSchema = z
  .strictObject({
    total: count,
    byStatus: z.strictObject({ active: count, pending: count, disabled: count }),
    pendingActivation: count,
    locked: count,
  })
  .openapi("StaffCounts");

export type StaffUpdateBody = z.infer<typeof StaffUpdateBodySchema>;
export type ActivationDeliveryBody = z.infer<typeof ActivationDeliveryBodySchema>;
export type StaffResetBody = z.infer<typeof StaffResetBodySchema>;
export type StaffDisableBody = z.infer<typeof StaffDisableBodySchema>;
export type HandoverBody = z.infer<typeof HandoverBodySchema>;
export type StaffUnlockBody = z.infer<typeof StaffUnlockBodySchema>;
export type StaffWecomBindBody = z.infer<typeof StaffWecomBindBodySchema>;
export type StaffPoolMembershipReplaceBody = z.infer<typeof StaffPoolMembershipReplaceBodySchema>;
export type StaffDutyBody = z.infer<typeof StaffDutyBodySchema>;
export type StaffSessionListQuery = z.infer<typeof StaffSessionListQuerySchema>;
export type StaffSessionView = z.infer<typeof StaffSessionViewSchema>;
export type StaffGroupListQuery = z.infer<typeof StaffGroupListQuerySchema>;
export type StaffGroupSummary = z.infer<typeof StaffGroupSummarySchema>;
export type AssignmentPoolListQuery = z.infer<typeof AssignmentPoolListQuerySchema>;
export type OpenWorkSummary = z.infer<typeof OpenWorkSummarySchema>;
export type StaffCounts = z.infer<typeof StaffCountsSchema>;
