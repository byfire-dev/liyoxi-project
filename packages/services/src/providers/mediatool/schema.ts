// mediatool 调用端的结构（D5 第 2 节 MediaToolProvider、第 6.2、6.6、12.1 节）。
// 容器的应答一律当作不可信数据：先过这里的 Zod，再给调用方。请求与应答长什么样，以本文件为准；
// 容器内服务（infra/docker/mediatool/service/）是不带依赖的 JavaScript，照着这里出数据。

import { z } from "zod";

/** 允许强制的解复用器。按登记的扩展名选：mp4 / mov / m4a → mov，mp3 → mp3，wav → wav，aac → 依次试 aac、mov */
export const MEDIATOOL_DEMUXERS = ["mov", "mp3", "wav", "aac"] as const;
export type MediaToolDemuxer = (typeof MEDIATOOL_DEMUXERS)[number];

/** 调用端对输出的上限（D5 第 6.6 节“输出”行） */
export const MEDIATOOL_LIMITS = {
  /** 应答 JSON 不超过 4MB */
  maxResponseBytes: 4 * 1024 * 1024,
  /** 封面不超过 1MB */
  maxPosterBytes: 1024 * 1024,
  /** 加标产物的大小在输入 ±1MB 内 */
  maxStampDeltaBytes: 1024 * 1024,
} as const;

/**
 * AI 隐式标识的七个字段（GB 45438-2025；D5 第 12.1 节）。结构借自参考工程 packages/services/src/render/spec.ts 的
 * RenderAigcSchema；它的 ProduceID 正则带旧名，没有借。各字段的取值口径待法务定（D5 第 20 节 Q9），
 * ProduceID 的格式留给 G3-A：这里只管“七个字段都在、都是字符串、不超长”。
 */
export const AigcLabelSchema = z.strictObject({
  Label: z.string().min(1).max(16),
  ContentProducer: z.string().max(128),
  ProduceID: z.string().min(1).max(128),
  ReservedCode1: z.string().max(128),
  ContentPropagator: z.string().max(128),
  PropagateID: z.string().max(128),
  ReservedCode2: z.string().max(128),
});
export type AigcLabel = z.infer<typeof AigcLabelSchema>;

/**
 * 写进 AIGC 元数据的 JSON：七个字段按标准的顺序。
 * 借自参考工程 packages/services/src/render/finalize.ts 的 aigcMetadataJson。
 */
export function aigcMetadataJson(label: AigcLabel): string {
  return JSON.stringify({
    Label: label.Label,
    ContentProducer: label.ContentProducer,
    ProduceID: label.ProduceID,
    ReservedCode1: label.ReservedCode1,
    ContentPropagator: label.ContentPropagator,
    PropagateID: label.PropagateID,
    ReservedCode2: label.ReservedCode2,
  });
}

const int = z.number().int();
const text = (max: number) => z.string().max(max).nullable();

/** 一条流。成片体检项 H2–H4、S5–S7（D5 第 6.2 节）要用的字段都在这里 */
export const ProbeStreamSchema = z.object({
  index: int.nullable(),
  /** video / audio / data / subtitle */
  codecType: text(32),
  codecName: text(64),
  profile: text(64),
  pixFmt: text(32),
  bitsPerRawSample: int.nullable(),
  /** 编码尺寸（旋转前） */
  width: int.nullable(),
  height: int.nullable(),
  /** 0 / 90 / 180 / 270，极少数片子会是别的角度 */
  rotation: int.min(0).max(359),
  /** 显示尺寸（旋转后）：判横竖只能用它 */
  displayWidth: int.nullable(),
  displayHeight: int.nullable(),
  sampleAspectRatio: text(32),
  /** 形如 30/1。两者不相等即非恒定帧率 */
  rFrameRate: text(32),
  avgFrameRate: text(32),
  nbFrames: int.nullable(),
  startTimeMs: int.nullable(),
  durationMs: int.nullable(),
  bitRate: int.nullable(),
  sampleRate: int.nullable(),
  channels: int.nullable(),
  /** 封面图那种“附带的图片”也算一条视频流 */
  attachedPic: z.boolean(),
});
export type ProbeStream = z.infer<typeof ProbeStreamSchema>;

/** 体检报告：媒体信息、顶层 box 顺序、AIGC 标签 */
export const ProbeReportSchema = z.object({
  /** 实际解开它的解复用器 */
  demuxer: z.enum(MEDIATOOL_DEMUXERS),
  format: z.object({
    formatName: text(128),
    majorBrand: text(64),
    durationMs: int.nullable(),
    sizeBytes: int.nonnegative(),
    bitRate: int.nullable(),
    tags: z.record(z.string(), z.string()),
  }),
  streams: z.array(ProbeStreamSchema).max(64),
  /** 顶层 box 的类型序列，只对 mov 一族有内容 */
  boxes: z.array(z.string().length(4)).max(64),
  /** faststart：moov 在 mdat 之前 */
  moovBeforeMdat: z.boolean(),
  /** format.tags.AIGC 的原文；没有即 null。逐字段解析用 parseAigc */
  aigc: z.string().max(4096).nullable(),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

/** 把体检报告里的 AIGC 原文解析成七个字段；没有、不是 JSON 或字段不齐都返回 null */
export function parseAigc(report: Pick<ProbeReport, "aigc">): AigcLabel | null {
  if (report.aigc === null) return null;
  try {
    const parsed = AigcLabelSchema.safeParse(JSON.parse(report.aigc));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const failure = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string().max(64), message: z.string().max(2000) }),
});

/** 三个操作与健康检查的应答。办成与没办成共用一个壳，靠 ok 区分 */
export const ProbeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), report: ProbeReportSchema }),
  failure,
]);

export const PosterResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), sizeBytes: int.positive(), atMs: int.nonnegative() }),
  failure,
]);

export const StampResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    report: ProbeReportSchema,
    inputSizeBytes: int.nonnegative(),
    outputSizeBytes: int.positive(),
  }),
  failure,
]);

export const HealthResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    service: z.literal("mediatool"),
    ffmpeg: z.string().max(64),
    ffprobe: z.string().max(64),
  }),
  failure,
]);
export const WatermarkPngResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    sizeBytes: int.positive().max(1024 ** 2),
    width: z.literal(720),
    height: z.literal(96),
  }),
  failure,
]);
export type MediaToolHealth = { ffmpeg: string; ffprobe: string };

/** Real codepoints, not HTML/similarity; only PDF has an actual page count. */
export const DocTextResultSchema = z
  .strictObject({
    text: z.string().min(1).max(500_000),
    truncated: z.boolean(),
    charCount: int.min(1).max(250_000),
    pageCount: int.min(1).max(100).optional(),
  })
  .refine((value) => {
    const count = Array.from(value.text).length;
    return count <= value.charCount && value.truncated === count < value.charCount;
  }, "文档字数与截断事实不一致");
export type DocTextResult = z.infer<typeof DocTextResultSchema>;
export const DocTextResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), ...DocTextResultSchema.shape }).refine((value) => {
    const { ok: _, ...facts } = value;
    return DocTextResultSchema.safeParse(facts).success;
  }, "文档字数与截断事实不一致"),
  failure,
]);
