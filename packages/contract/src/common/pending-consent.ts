// PendingConsent 归 m01 第 2.5 节（C87）；公共错误与引导共用，避免 common → routes 的环。
import { z } from "../zod.js";
import { IdSchema, InstantSchema } from "./scalars.js";

export const PendingConsentSchema = z
  .object({
    agreementKey: z.string(),
    agreementVersionId: IdSchema,
    name: z.string(),
    versionLabel: z.string().regex(/^v\d+\.\d+$/),
    effectiveAt: InstantSchema,
    summary: z.string(),
  })
  .openapi("PendingConsent");
export type { PendingConsent } from "./pending-consent.types.js";
