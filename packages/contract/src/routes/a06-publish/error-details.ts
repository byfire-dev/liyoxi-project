import { z } from "../../zod.js";
import { COMPARE_FIELDS } from "./publish.schemas.js";
export const A06_ERROR_DETAILS = {
  ACCOUNT_COMPARE_MISMATCH: z.object({ fields: z.array(z.enum(COMPARE_FIELDS)) }),
  LAUNCH_VERIFY_COUNT_OUT_OF_RANGE: z.object({ min: z.int(), max: z.int() }),
};
