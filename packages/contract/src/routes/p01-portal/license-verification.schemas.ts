import { z } from "../../zod.js";
import { InstantSchema } from "../../common/index.js";
import {
  LICENSE_LETTER_REVISION_REASON,
  LICENSE_LETTER_REVISION_SIGN_MODE,
} from "../../enums/docs.js";
import { LicenseLetterPreviewSchema } from "../m05-delivery-publish/license.schemas.js";

export const LicenseVerificationQuerySchema = z
  .strictObject({
    code: z.string().min(1).max(64),
    // Invalid revNo is deliberately equivalent to omission, including malformed QR values.
    revNo: z.preprocess((value) => {
      if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value)))
        return undefined;
      const number = Number(value);
      return Number.isSafeInteger(number) && number > 0 ? number : undefined;
    }, z.int().positive().optional()),
  })
  .openapi("LicenseVerificationQuery");
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const proof = {
  revNo: z.int().positive(),
  reason: z.enum(LICENSE_LETTER_REVISION_REASON.values),
  contentFp: hash,
  pdfSha256: hash,
  issuedAt: InstantSchema,
};
export const LicenseRevisionProofSchema = z
  .strictObject({
    ...proof,
    signMode: z.enum(LICENSE_LETTER_REVISION_SIGN_MODE.values),
    certSerial: z.string().nullable(),
    certIssuer: z.string().nullable(),
    platformSignedAt: InstantSchema,
  })
  .openapi("LicenseRevisionProof");
export const LicenseRevisionBriefSchema = z
  .strictObject({ ...proof, isCurrent: z.boolean() })
  .openapi("LicenseRevisionBrief");
export const LicenseVerificationViewSchema = z
  .strictObject({
    letterNo: z.string(),
    displayStatus: z.enum(["pending_effective", "effective", "expired", "voided"]),
    voidedAt: InstantSchema.nullable(),
    platform: z.enum(["douyin", "wechat_channels"]),
    licensorName: z.string(),
    licenseeNameMask: z.string(),
    licenseeCreditCodeMask: z.string(),
    dramaName: z.string(),
    episodes: z.int().positive(),
    account: LicenseLetterPreviewSchema.shape.account,
    period: LicenseLetterPreviewSchema.shape.period,
    consent: LicenseLetterPreviewSchema.shape.consent,
    currentRevision: LicenseRevisionProofSchema,
    hasPendingRevision: z.boolean(),
    revisions: z.array(LicenseRevisionBriefSchema),
    requestedRevNo: z.int().positive().nullable(),
    requestedRevisionState: z.enum(["not_requested", "current", "outdated", "not_found"]),
    checkedAt: InstantSchema,
  })
  .openapi("LicenseVerificationView");
export type LicenseVerificationQuery = z.infer<typeof LicenseVerificationQuerySchema>;
export type LicenseVerificationView = z.infer<typeof LicenseVerificationViewSchema>;
