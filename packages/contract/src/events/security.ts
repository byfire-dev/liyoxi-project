import { WEBHOOK_EVENT_PROVIDER } from "../enums/security.js";
import { IdSchema } from "../common/index.js";
import { z } from "../zod.js";

export const payloads = {
  "webhook.received": z.strictObject({
    v: z.literal(1),
    webhookEventId: IdSchema,
    provider: z.enum(WEBHOOK_EVENT_PROVIDER.values),
  }),
} as const;
