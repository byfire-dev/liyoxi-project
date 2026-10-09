import { z } from "../../zod.js";
export const CiWakeQuerySchema = z
  .object({ sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .openapi("CiWakeQuery");
/** Raw body is verified by the source before OpenAPI parsing; only JobId is projected. */
export const CiWakeBodySchema = z.unknown().openapi("CiWakeBody");
