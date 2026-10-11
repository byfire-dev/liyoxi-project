import { z } from "zod";

export const LLM_VISION_LIMITS = {
  imageCount: 14,
  inputBytes: 64 * 1024,
  urlBytes: 8 * 1024,
  descriptionChars: 2000,
  qualityChars: 500,
  textChars: 8000,
} as const;

const chars = (max: number) => z.string().refine((value) => Array.from(value).length <= max);

/** D5 §9.2 五项真实视觉事实；空文本是明确事实，不补默认或猜测身份。 */
export const LlmVisionSchema = z
  .object({
    description: chars(LLM_VISION_LIMITS.descriptionChars),
    quality: chars(LLM_VISION_LIMITS.qualityChars),
    hasPeople: z.boolean(),
    identifiableCustomerFace: z.boolean(),
    textInImage: chars(LLM_VISION_LIMITS.textChars),
  })
  .strict();

export type LlmVision = z.infer<typeof LlmVisionSchema>;

export interface LlmVisionInput {
  readonly imageUrls: readonly string[];
  readonly signal?: AbortSignal;
}

function validUrl(value: string): boolean {
  if (
    Buffer.byteLength(value, "utf8") > LLM_VISION_LIMITS.urlBytes ||
    Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 32 || code === 127 || char === "#";
    })
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

const inputSchema = z
  .object({
    imageUrls: z.array(z.string().refine(validUrl)).min(1).max(LLM_VISION_LIMITS.imageCount),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

type VisionContent = Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
>;

/** 按调用时原序复制 URL；64KiB 界定实际 user content JSON，绝不截断图或文本。 */
export function prepareVision(
  input: unknown,
):
  | { content: VisionContent; parse(value: unknown): LlmVision | undefined; signal?: AbortSignal }
  | undefined {
  const checked = inputSchema.safeParse(input);
  if (!checked.success) return undefined;
  const content: VisionContent = [
    {
      type: "text",
      text: "Describe these images in order using only visible facts. Never identify people or infer identity.",
    },
    ...checked.data.imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > LLM_VISION_LIMITS.inputBytes)
    return undefined;
  return {
    content,
    ...(checked.data.signal === undefined ? {} : { signal: checked.data.signal }),
    parse(value) {
      const result = LlmVisionSchema.safeParse(value);
      return result.success ? result.data : undefined;
    },
  };
}

export const VISION_JSON_INSTRUCTIONS =
  '{"description": string <=2000 Unicode code points, "quality": string <=500 Unicode code points, ' +
  '"hasPeople": boolean, "identifiableCustomerFace": boolean, "textInImage": string <=8000 Unicode code points}; ' +
  "all five keys required, no other keys. Empty strings are allowed as explicit facts. " +
  "Describe only visible content and quality; report visible text without inferring missing evidence. " +
  "Never identify people, infer identity or treat visible faces as consent.";

/** 复用真实发送输入的纯校验；不检查配置、授权、预算或取消状态。 */
export function isLlmVisionInput(value: unknown): value is LlmVisionInput {
  return prepareVision(value) !== undefined;
}
