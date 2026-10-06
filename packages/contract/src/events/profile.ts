import { IdSchema } from "../common/index.js";
import { QUALIFICATION_SUBMISSION_KIND } from "../enums/index.js";
import { z } from "../zod.js";
const subject = { v: z.literal(1), storeId: IdSchema, entityId: IdSchema, submissionId: IdSchema };
export const payloads = {
  "store.qualification.submitted": z.strictObject({
    ...subject,
    kind: z.enum(QUALIFICATION_SUBMISSION_KIND.values),
    roundNo: z.int().positive(),
  }),
  "store.qualification.approved": z.strictObject({
    ...subject,
    kind: z.enum(QUALIFICATION_SUBMISSION_KIND.values),
  }),
  "store.qualification.rejected": z.strictObject({
    ...subject,
    isFinal: z.boolean(),
    reasonCodes: z.array(z.string()),
    isSystem: z.boolean(),
  }),
  "store.profile.changed": z.strictObject({
    v: z.literal(1),
    storeId: IdSchema,
    entityId: IdSchema,
    fields: z.array(z.string()),
    source: z.enum(["merchant", "staff", "review_writeback"]),
  }),
};
