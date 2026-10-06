import { z } from "../../zod.js";
import { DateSchema, IdSchema } from "../../common/index.js";
export const M05_ERROR_DETAILS = {
  ORDER_IN_AFTER_SALE: z.object({ cancelRequestId: IdSchema }),
  PLAN_VERSION_STALE: z.object({ currentVersionNo: z.int().nonnegative() }),
  TICKET_ON_HOLD: z.object({ reasons: z.array(z.enum(["cancel_review", "plan_amendment"])) }),
  LINK_INVALID: z.object({
    field: z.string(),
    reason: z.enum([
      "unparsable",
      "not_https",
      "too_long",
      "has_credentials",
      "duplicate_episode",
      "episode_out_of_range",
    ]),
  }),
  LAUNCH_SUBMISSION_OUT_OF_RANGE: z.union([
    z.object({ field: z.literal("actualLaunchDate"), min: DateSchema, max: DateSchema, IdSchema }),
    z.object({ field: z.literal("reportedEpisodeCount"), min: z.int(), max: z.int() }),
  ]),
  LAUNCH_WINDOW_CLOSED: z.object({ usageEndDate: DateSchema, IdSchema }),
};
