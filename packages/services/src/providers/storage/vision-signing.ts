import { z } from "zod";
import { STORAGE_BUCKETS } from "../types.js";

const schema = z.strictObject({
  bucket: z.enum(STORAGE_BUCKETS),
  key: z
    .string()
    .min(1)
    .refine(
      (key) =>
        Buffer.byteLength(key) <= 1024 &&
        !/[\p{Cc}\p{Cs}\\]/u.test(key) &&
        !key.split("/").some((part) => part === "." || part === ".."),
    ),
  expiresSec: z.number().int().min(1).max(3600),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("image") }),
    z.strictObject({
      kind: z.literal("video-frame"),
      atMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  ]),
});

/** Only the fixed domestic CI transformation; no caller-supplied query or endpoint. */
export function prepareVisionRead(input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return undefined;
  const source = parsed.data.source;
  const query: Record<string, string> =
    source.kind === "image"
      ? {
          "imageMogr2/auto-orient|imageMogr2/thumbnail/1280x1280>|imageMogr2/format/jpg": "",
        }
      : {
          "ci-process": "snapshot",
          time: `${Math.floor(source.atMs / 1000)}.${String(source.atMs % 1000).padStart(3, "0")}`,
          width: "0",
          height: "0",
          format: "jpg",
          rotate: "auto",
          mode: "exactframe",
          "imageMogr2/thumbnail/1280x1280>": "",
        };
  return { input: parsed.data, query };
}

export const VISION_CI_REGIONS: ReadonlySet<string> = new Set([
  "ap-beijing",
  "ap-shanghai",
  "ap-guangzhou",
  "ap-chengdu",
  "ap-chongqing",
  "ap-nanjing",
]);
