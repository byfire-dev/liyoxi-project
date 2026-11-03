import { z } from "../../zod.js";
import { COMPARE_FIELDS } from "./publish.schemas.js";
import { DateSchema, IdSchema } from "../../common/index.js";
export const A06_ERROR_DETAILS = {
  TAKEDOWN_NOT_OVERDUE: z.object({ dueDate: DateSchema }),
  TAKEDOWN_BATCH_REJECTED: z.object({
    items: z.array(
      z.object({
        index: z.int().nonnegative(),
        takedownTaskId: IdSchema,
        error: z.string(),
        message: z.string(),
      }),
    ),
  }),
  ACCOUNT_COMPARE_MISMATCH: z.object({ fields: z.array(z.enum(COMPARE_FIELDS)) }),
  LAUNCH_VERIFY_COUNT_OUT_OF_RANGE: z.object({ min: z.int(), max: z.int() }),
};
