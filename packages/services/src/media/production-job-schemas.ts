import { z } from "zod";
import { TechnicalSchema } from "./production-report.js";

export const ProbeInputSchema = z.strictObject({
  fileId: z.uuid(),
  profile: z.enum(["master", "trailer_src", "ad", "sample", "final", "asset"]),
  ruleVersion: z.number().int().min(1).max(32767),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  coverFileId: z.uuid(),
});
export const ProbeArtifactSchema = z.strictObject({
  id: z.uuid(),
  key: z.string().max(512),
  size: z
    .number()
    .int()
    .positive()
    .max(1024 ** 2),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  etag: z.string().min(1).max(256),
});
export const ProbeOutputSchema = z.strictObject({
  technical: TechnicalSchema,
  cover: ProbeArtifactSchema.nullable(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const DerivationInputSchema = z.strictObject({
  fileId: z.uuid(),
  destinationFileId: z.uuid(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  ruleVersion: z.number().int().min(1).max(32767),
  objectKey: z.string().regex(/^derived\/[0-9a-f-]{36}\/(restamp|normalize)-v\d{1,5}\.mp4$/),
  template: z.string().min(1).max(128),
  /** Versioned manual destination proof; legacy automatic derivations omit it. */
  manual: z
    .strictObject({
      version: z.literal(1),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      destinationContextHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export const DerivationOutputSchema = z.strictObject({
  fileId: z.uuid(),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  etag: z.string().min(1).max(256),
  technical: TechnicalSchema,
  aigcOrigin: z.enum(["upstream", "stamped"]).nullable(),
});
