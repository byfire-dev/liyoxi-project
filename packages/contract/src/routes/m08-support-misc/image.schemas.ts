// ImageRef 的公共归属见 m08 §2.1；结果重放使用各写接口的可空投影。
import { z } from "../../zod.js";
import { IdSchema, InstantSchema } from "../../common/index.js";
export const ImageRefSchema = z
  .strictObject({ fileId: IdSchema, url: z.string(), expiresAt: InstantSchema })
  .openapi("ImageRef");
export type ImageRef = z.infer<typeof ImageRefSchema>;
