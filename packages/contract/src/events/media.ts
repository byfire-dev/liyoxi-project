import { IdSchema } from "../common/index.js";
import { z } from "../zod.js";
const fileFact = z.object({ v: z.literal(1), fileId: IdSchema }).strict();
export const payloads = {
  "file.uploaded": fileFact,
  "file.stored": fileFact,
  "file.rejected": fileFact,
} as const;
