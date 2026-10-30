import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";
import { LICENSE_LETTER_REVISION_REASON, LICENSE_LETTER_VOID_REASON } from "../enums/index.js";

export const payloads = {
  "license_letter.revision_queued": z.strictObject({
    v: z.literal(1),
    licenseLetterId: IdSchema,
    revisionId: IdSchema,
    reason: z.enum(LICENSE_LETTER_REVISION_REASON.values),
  }),
  "license_letter.voided": z.strictObject({
    v: z.literal(1),
    licenseLetterId: IdSchema,
    voidReason: z.enum(LICENSE_LETTER_VOID_REASON.values),
    fromState: z.enum(["pending_effective", "effective"]),
    toState: z.literal("voided"),
    transition: z.literal("license_letter.void"),
  }),
} as const;
