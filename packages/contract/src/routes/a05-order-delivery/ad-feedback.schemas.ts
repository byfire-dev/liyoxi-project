import { z } from "../../zod.js";
import { IdSchema } from "../../common/index.js";
import { AdCancelCoreSubmitBodySchema } from "./cancel.schemas.js";

export const AdminAdParamSchema = z.strictObject({ adId: IdSchema });
export const AdCancelRequestCreateBodySchema = AdCancelCoreSubmitBodySchema.extend({
  serviceTicketId: IdSchema.optional(),
});
export type AdCancelRequestCreateBody = z.infer<typeof AdCancelRequestCreateBodySchema>;

const feedback = {
  versionNo: z.int().positive(),
  note: z.string().trim().min(1).max(200),
  feedbackTimeMs: z.int().nonnegative().optional(),
  feedbackFileIds: z
    .array(IdSchema)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
};
export const AdminSampleRequestChangeBodySchema = z.discriminatedUnion("feedbackKind", [
  z.strictObject({ ...feedback, feedbackKind: z.literal("compose") }),
  z.strictObject({ ...feedback, feedbackKind: z.literal("ad_content"), adId: IdSchema }),
]);
export type AdminSampleRequestChangeBody = z.infer<typeof AdminSampleRequestChangeBodySchema>;
