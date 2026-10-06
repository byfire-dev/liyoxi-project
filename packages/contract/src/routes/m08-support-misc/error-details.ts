// 上传错误 details（m08 第 5 节），FILE_NOT_USABLE 由 m03 的统一结构提供。
import type { DomainErrorSymbol } from "../../errors/index.js";
import { openEnum } from "../../common/index.js";
import { FILE_OBJECT_REJECT_REASON } from "../../enums/index.js";
import { z } from "../../zod.js";

export const M08_ERROR_DETAILS = {
  FILE_TYPE_NOT_ALLOWED: z.object({ allowedExts: z.array(z.string()) }),
  FILE_TOO_LARGE: z.object({ maxBytes: z.string(), canDelegate: z.boolean() }),
  UPLOAD_REJECTED: z.object({ rejectReason: openEnum(FILE_OBJECT_REJECT_REASON.values) }),
} satisfies Partial<Record<DomainErrorSymbol, z.ZodType>>;
