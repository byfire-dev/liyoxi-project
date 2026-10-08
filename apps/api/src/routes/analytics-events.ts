import { AnalyticsIngestResultSchema, mAnalyticsEventBatchCreate } from "@liyoxi/contract";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";

export const analyticsEventHandlers = [
  defineHandler(mAnalyticsEventBatchCreate, async (c) => {
    const env = c.req.header("X-Env-Version");
    const result = await c.var.runtime.analytics.receive(c.req.valid("json"), {
      merchantUserId: c.get("merchantSession")?.merchantUserId ?? null,
      storeId: c.req.header("X-Store-Id") ?? null,
      flagContext: {
        platform: c.req.header("X-Client-Platform") ?? null,
        clientVersion: c.req.header("X-Client-Version") ?? null,
        envVersion: env === "develop" || env === "trial" || env === "release" ? env : null,
      },
      idem: idemOf(c),
    });
    return ok(c, AnalyticsIngestResultSchema.parse(result));
  }),
];
