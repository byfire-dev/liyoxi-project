import { DateSchema, IdSchema, openEnum } from "../../common/index.js";
import { z } from "../../zod.js";
export const A05_ERROR_DETAILS = {
  PLAN_CONTENT_INVALID: z.object({
    issues: z.array(
      z.object({
        orderItemId: IdSchema.nullable(),
        field: z.string(),
        reason: openEnum([
          "item_missing",
          "placement_missing",
          "placement_not_allowed",
          "ad_invalid",
          "ad_type_mismatch",
          "account_invalid",
          "account_missing",
          "launch_date_missing",
          "ticket_unassigned",
          "reference_unusable",
        ]),
      }),
    ),
  }),
  LAUNCH_DATE_OUT_OF_RANGE: z.object({
    orderItemId: IdSchema,
    minDate: DateSchema,
    maxDate: DateSchema,
  }),
  PRODUCTION_NOT_READY: z.object({
    fileId: IdSchema,
    pipelineState: z.string(),
    gate: z.enum(["pass", "reject"]).nullable(),
  }),
  EPISODE_REGISTER_NOT_ALLOWED: z.object({
    step: z.string(),
    reason: z.enum(["step", "reissue_required", "not_in_reissue"]),
  }),
  PACKAGE_PUSH_BLOCKED: z.object({
    blockers: z.array(
      z.object({
        code: z.enum([
          "episodes_incomplete",
          "episode_qc_pending",
          "package_qc_pending",
          "publish_list_incomplete",
          "license_letter_missing",
          "account_unbound",
          "abnormal_account_ack_required",
          "launch_date_missing",
          "usage_ended",
        ]),
        episodeNos: z.array(z.int()).optional(),
        channelAccountId: IdSchema.optional(),
        checklistKeys: z.array(z.string()).optional(),
      }),
    ),
  }),
  ASSIGNEE_INVALID: z.object({
    staffId: IdSchema,
    reason: openEnum(["not_active", "role_mismatch", "same_as_current", "out_of_scope"]),
  }),
};
