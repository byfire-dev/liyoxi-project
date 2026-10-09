import { z } from "zod";
import type { ProbeReport, AigcLabel } from "../providers/types.js";
import type { ProductionTechnicalFacts } from "@liyoxi/shared";
const integer = z.number().int().min(0).max(2_147_483_647).nullable();
const text = z.string().max(128).nullable();
export const LabelSchema = z.strictObject({
  Label: z.string().min(1).max(16),
  ContentProducer: z.string().max(128),
  ProduceID: z.string().min(1).max(128),
  ReservedCode1: z.string().max(128),
  ContentPropagator: z.string().max(128),
  PropagateID: z.string().max(128),
  ReservedCode2: z.string().max(128),
});
export const TechnicalSchema = z.strictObject({
  kind: z.enum(["video", "audio"]),
  container: text,
  durationMs: integer,
  width: integer,
  height: integer,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  displayWidth: integer,
  displayHeight: integer,
  fpsNum: integer,
  fpsDen: integer,
  vcodec: text,
  vprofile: text,
  pixFmt: text,
  bitDepth: integer,
  acodec: text,
  audioSampleRate: integer,
  audioChannels: integer,
  audioStreamCount: z.number().int().min(0).max(64),
  bitrateKbps: integer,
  isFaststart: z.boolean(),
  avDriftMs: integer,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  aigcMeta: LabelSchema.nullable(),
  invalidAigc: z.boolean(),
  vfr: z.boolean(),
  raw: z.strictObject({
    demuxer: z.enum(["mov", "mp3", "wav", "aac"]),
    formatName: text,
    majorBrand: text,
    boxes: z.array(z.string().length(4)).max(64),
  }),
});
export type Technical = z.infer<typeof TechnicalSchema>;
export function parseLabel(value: string | null): AigcLabel | null {
  if (value === null || value.length > 4096) return null;
  try {
    const result = LabelSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function rate(value: string | null): [number | null, number | null] {
  if (!value || !/^\d{1,10}\/\d{1,10}$/.test(value)) return [null, null];
  const parts = value.split("/").map(Number);
  return parts.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)
    ? [parts[0]!, parts[1]!]
    : [null, null];
}
/** Provider output is projected to technical fields; source titles/comments/user tags never persist. */
export function technicalReport(report: ProbeReport): Technical | null {
  const video = report.streams.find((s) => s.codecType === "video" && !s.attachedPic);
  const audio = report.streams.filter((s) => s.codecType === "audio"),
    first = audio[0];
  if (!video && !first) return null;
  const [fpsNum, fpsDen] = rate(video?.avgFrameRate ?? null),
    label = parseLabel(report.aigc);
  const brand = report.format.majorBrand?.trim() ?? null;
  const container =
    report.demuxer === "mov"
      ? /^(isom|iso[2-9]|avc1|mp4[12]|M4[AV]|dash)$/.test(brand ?? "")
        ? "mp4"
        : "mov"
      : report.demuxer;
  const drift =
    video?.durationMs !== null &&
    video?.durationMs !== undefined &&
    first?.durationMs !== null &&
    first?.durationMs !== undefined
      ? Math.abs(video.durationMs - first.durationMs)
      : null;
  const result = TechnicalSchema.safeParse({
    kind: video ? "video" : "audio",
    container,
    durationMs: report.format.durationMs,
    width: video?.width ?? null,
    height: video?.height ?? null,
    rotation: video?.rotation ?? 0,
    displayWidth: video?.displayWidth ?? null,
    displayHeight: video?.displayHeight ?? null,
    fpsNum,
    fpsDen,
    vcodec: video?.codecName ?? null,
    vprofile: video?.profile ?? null,
    pixFmt: video?.pixFmt ?? null,
    bitDepth: video?.bitsPerRawSample ?? (video?.pixFmt === "yuv420p" ? 8 : null),
    acodec: first?.codecName ?? null,
    audioSampleRate: first?.sampleRate ?? null,
    audioChannels: first?.channels ?? null,
    audioStreamCount: audio.length,
    bitrateKbps: report.format.bitRate === null ? null : Math.ceil(report.format.bitRate / 1000),
    isFaststart: report.moovBeforeMdat,
    avDriftMs: drift,
    sizeBytes: report.format.sizeBytes,
    aigcMeta: label,
    invalidAigc: report.aigc !== null && label === null,
    vfr: !!video && video.rFrameRate !== video.avgFrameRate,
    raw: {
      demuxer: report.demuxer,
      formatName: report.format.formatName,
      majorBrand: brand,
      boxes: report.boxes,
    },
  });
  return result.success ? result.data : null;
}
export function checkFacts(info: Technical): ProductionTechnicalFacts {
  return {
    container: info.container,
    videoCodec: info.vcodec,
    videoProfile: info.vprofile,
    pixelFormat: info.pixFmt,
    bitDepth: info.bitDepth,
    displayWidth: info.displayWidth,
    displayHeight: info.displayHeight,
    audioCodec: info.acodec,
    audioStreamCount: info.audioStreamCount,
    sizeBytes: info.sizeBytes,
    durationMs: info.durationMs,
    aigcVerified: info.aigcMeta !== null && !info.invalidAigc,
    faststart: info.isFaststart,
    frameRate: info.fpsNum && info.fpsDen ? info.fpsNum / info.fpsDen : null,
    variableFrameRate: info.vfr,
    avDriftMs: info.avDriftMs,
    bitrateKbps: info.bitrateKbps,
  };
}
