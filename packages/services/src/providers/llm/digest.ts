import { z } from "zod";
import { LLM_LIMITS } from "./config.js";

/** 协议有界集合；不是另一份业务标签词表。 */
export const LLM_DIGEST_LIMITS = {
  vocabularyEntries: 256,
  rawTags: 256,
  rawTagChars: 100,
} as const;
const code = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);
const chars = (max: number) => z.string().refine((value) => Array.from(value).length <= max);
const date = z.iso.date();
const ordered = (value: { from?: string; to?: string }) =>
  value.from === undefined || value.to === undefined || value.from <= value.to;

/** D5 §9.3：字段必填和可选性不补默认，长度按 Unicode 码点。 */
export const LlmDigestSchema = z.strictObject({
  title: chars(20),
  keypoints: z.array(chars(60)).max(6),
  contentTags: z.array(code).max(4),
  suggestedUsage: z.array(code).max(3),
  suggestedTimeliness: z
    .strictObject({ code, from: date.optional(), to: date.optional() })
    .refine(ordered)
    .optional(),
  faceHint: z.enum(["none", "people_unclear", "identifiable_customer"]),
  qualityNotes: z.array(chars(40)).max(3),
  structuredItems: z
    .array(z.strictObject({ name: chars(30), price: chars(20).optional() }))
    .max(50)
    .optional(),
});
export type LlmDigest = z.infer<typeof LlmDigestSchema>;
export interface LlmDigestVocabulary {
  readonly content: ReadonlyArray<{ readonly code: string; readonly label: string }>;
  readonly usage: ReadonlyArray<{ readonly code: string; readonly label: string }>;
  readonly timeliness: ReadonlyArray<{ readonly code: string; readonly label: string }>;
}
export interface LlmDigestInput {
  readonly text: string;
  /** 调用者按真实可选 asset_tag.dimension 投影 code/name，不传固定中文枚举。 */
  readonly vocabulary: LlmDigestVocabulary;
  readonly signal?: AbortSignal;
}

const entries = z
  .array(z.strictObject({ code, label: z.string().min(1).max(20) }))
  .max(LLM_DIGEST_LIMITS.vocabularyEntries);
const inputSchema = z.strictObject({
  text: z
    .string()
    .refine((value) => value.trim().length > 0 && Buffer.byteLength(value) <= LLM_LIMITS.textBytes),
  vocabulary: z.strictObject({ content: entries, usage: entries, timeliness: entries }),
  signal: z.instanceof(AbortSignal).optional(),
});
const rawCode = chars(LLM_DIGEST_LIMITS.rawTagChars);
const rawSchema = LlmDigestSchema.extend({
  contentTags: z.array(rawCode).max(LLM_DIGEST_LIMITS.rawTags),
  suggestedUsage: z.array(rawCode).max(LLM_DIGEST_LIMITS.rawTags),
  suggestedTimeliness: z
    .strictObject({ code: rawCode, from: date.optional(), to: date.optional() })
    .refine(ordered)
    .optional(),
});

/** 先复制与界定调用者词表；发送内容和回包过滤使用同一不可变快照。 */
export function prepareDigest(
  input: unknown,
): { content: string; parse(value: unknown): LlmDigest | undefined } | undefined {
  const checked = inputSchema.safeParse(input);
  if (!checked.success) return undefined;
  const { text, vocabulary } = checked.data;
  const allCodes = [...vocabulary.content, ...vocabulary.usage, ...vocabulary.timeliness].map(
    (item) => item.code,
  );
  if (new Set(allCodes).size !== allCodes.length) return undefined;
  const content = JSON.stringify({ evidence: text, vocabulary });
  if (Buffer.byteLength(content) > LLM_LIMITS.textBytes) return undefined;
  const contentCodes = new Set(vocabulary.content.map((item) => item.code));
  const usageCodes = new Set(vocabulary.usage.map((item) => item.code));
  const timelinessCodes = new Set(vocabulary.timeliness.map((item) => item.code));
  return {
    content,
    parse(value) {
      const raw = rawSchema.safeParse(value);
      if (!raw.success) return undefined;
      const { suggestedTimeliness, ...fields } = raw.data;
      const result = LlmDigestSchema.safeParse({
        ...fields,
        contentTags: fields.contentTags.filter((item) => contentCodes.has(item)),
        suggestedUsage: fields.suggestedUsage.filter((item) => usageCodes.has(item)),
        ...(suggestedTimeliness && timelinessCodes.has(suggestedTimeliness.code)
          ? { suggestedTimeliness }
          : {}),
      });
      return result.success ? result.data : undefined;
    },
  };
}

export const DIGEST_JSON_INSTRUCTIONS =
  '{"title": string <=20 Unicode code points, "keypoints": array of <=6 strings <=60 code points, ' +
  '"contentTags": array of <=4 content vocabulary codes, "suggestedUsage": array of <=3 usage vocabulary codes, ' +
  '"suggestedTimeliness"?: {"code": timeliness vocabulary code, "from"?: YYYY-MM-DD, "to"?: YYYY-MM-DD}, ' +
  '"faceHint": "none" | "people_unclear" | "identifiable_customer", "qualityNotes": array of <=3 strings <=40 code points, ' +
  '"structuredItems"?: array of <=50 {"name": string <=30 code points, "price"?: string <=20 code points}}; ' +
  "no other keys. Use only supplied evidence and vocabulary, never identify people or infer missing visual evidence. " +
  "Required keys must be present; optional keys must be omitted when unknown.";

/** 复用真实发送输入的纯校验；不检查配置、授权、预算或取消状态。 */
export function isLlmDigestInput(value: unknown): value is LlmDigestInput {
  return prepareDigest(value) !== undefined;
}
