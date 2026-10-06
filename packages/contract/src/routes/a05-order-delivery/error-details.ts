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
  ASSIGNEE_INVALID: z.object({
    staffId: IdSchema,
    reason: openEnum(["not_active", "role_mismatch", "same_as_current", "out_of_scope"]),
  }),
};
