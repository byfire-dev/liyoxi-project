import { IdSchema, openEnum } from "../../common/index.js";
import { z } from "../../zod.js";
export const A05_ERROR_DETAILS = {
  ASSIGNEE_INVALID: z.object({
    staffId: IdSchema,
    reason: openEnum(["not_active", "role_mismatch", "same_as_current", "out_of_scope"]),
  }),
};
