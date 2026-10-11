import { z } from "../../zod.js";
import { IdSchema } from "../../common/index.js";

export const AsrWakeParamsSchema = z.object({ mediaJobId: IdSchema }).openapi("AsrWakeParams");
export const AsrWakeQuerySchema = z
  .object({
    sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .openapi("AsrWakeQuery");
/** Source verifies the original form bytes before any OpenAPI body parsing. */
export const AsrWakeBodySchema = z.unknown().openapi("AsrWakeBody");
export const HookAckSchema = z
  .object({
    code: z.literal(0),
    message: z.literal("success"),
  })
  .openapi("HookAck");
