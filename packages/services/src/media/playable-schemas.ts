import { z } from "zod";
import { checkProduction } from "@liyoxi/shared";
import type { ProductionCheckContext, ProductionCheckOptions } from "@liyoxi/shared";
import { TechnicalSchema, checkFacts } from "./production-report.js";
import type { Technical } from "./production-report.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(32767);
const sampleKey = z.string().regex(/^sample\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/);
export const CloudPlayableInputSchema = z.strictObject({
  fileId: z.uuid(),
  playableAssetId: z.uuid(),
  destinationFileId: z.uuid(),
  quality: z.enum(["sd", "hd", "source"]),
  objectKey: z
    .string()
    .regex(
      /^(?:t\/[0-9a-f-]{36}\/[a-f0-9]{16}\/(?:sd|hd)\.mp4|sample\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4)$/,
    ),
  scratchKey: z.string().regex(/^ci-out\/[0-9a-f-]{36}\/output\.mp4$/),
  template: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  specVersion: version,
  aiUsed: z.boolean(),
  watermarks: z
    .array(
      z.union([
        z.strictObject({ templateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
        z.strictObject({
          text: z.string().min(1).max(128),
          position: z.enum(["Center", "TopRight"]),
          fontSize: z.number().int().min(5).max(100),
          transparency: z.number().int().min(1).max(100),
        }),
      ]),
    )
    .max(3),
});
export const LocalSamplePlayableInputSchema = z.strictObject({
  execution: z.literal("local"),
  fileId: z.uuid(),
  playableAssetId: z.uuid(),
  destinationFileId: z.uuid(),
  quality: z.literal("source"),
  objectKey: sampleKey,
  specVersion: version,
  ruleVersion: version,
  sourceSha256: hash,
  contextHash: hash,
  recipe: z.literal("sample_center_v1"),
  aiUsed: z.literal(false),
  watermarks: z.tuple([
    z.strictObject({
      text: z.string().regex(/^样片 · 仅供「[^「」\p{Cc}\p{Cf}]{1,10}」确认 · \d{2}-\d{2}$/u),
      position: z.literal("Center"),
    }),
  ]),
});
export const PlayableInputSchema = z.union([
  CloudPlayableInputSchema,
  LocalSamplePlayableInputSchema,
]);
export const PlayableOutputSchema = z.strictObject({
  fileId: z.uuid(),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  sha256: hash,
  etag: z.string().min(1).max(256),
  technical: TechnicalSchema,
  aigcOrigin: z.enum(["upstream", "stamped"]).nullable(),
  quality: z.enum(["sd", "hd", "source"]),
});
export const LocalSamplePlayableOutputSchema = PlayableOutputSchema.extend({
  quality: z.literal("source"),
  aigcOrigin: z.null(),
}).strict();
export const RenditionSchema = z.strictObject({
  quality: z.enum(["sd", "hd", "source"]),
  fileId: z.uuid(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bitrateKbps: z.number().int().nonnegative().nullable(),
});

/** Local previews keep the checked source dimensions and still meet every production hard check. */
export function localSampleOutputValid(
  technical: Technical,
  source: { displayWidth: number | null; displayHeight: number | null; durationMs: number | null },
  context: ProductionCheckContext | null,
  parameters: ProductionCheckOptions,
) {
  const fps = technical.fpsNum && technical.fpsDen ? technical.fpsNum / technical.fpsDen : null;
  return (
    context?.aiUsed === false &&
    technical.aigcMeta === null &&
    !technical.invalidAigc &&
    technical.kind === "video" &&
    technical.isFaststart &&
    !technical.vfr &&
    fps !== null &&
    fps > 0 &&
    fps <= 30 &&
    technical.displayWidth === source.displayWidth &&
    technical.displayHeight === source.displayHeight &&
    source.durationMs !== null &&
    technical.durationMs !== null &&
    Math.abs(technical.durationMs - source.durationMs) <= 1000 &&
    checkProduction(checkFacts(technical), context, parameters).gate === "pass"
  );
}
