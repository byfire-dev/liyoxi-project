import { z } from "../../zod.js";
export const LaunchSubmissionRevokeBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(200),
  confirm: z.strictObject({
    roundNo: z.int().positive(),
    verifiedEpisodeCount: z.int().positive(),
  }),
});
export type LaunchSubmissionRevokeBody = z.infer<typeof LaunchSubmissionRevokeBodySchema>;
