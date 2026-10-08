import { uuidv7 } from "@liyoxi/services";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";

type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string };

/** 只增本包三条店员回放；既有样例与字段裁剪规则不变。 */
export const reportingClerkSamples = [
  {
    operationId: "m.analyticsEvent.batchCreate",
    play: (api: TestApi, ctx: ClerkSampleContext) =>
      api.request("/api/v1/m/analytics-events", {
        method: "POST",
        headers: ctx.clerk.withStore(ctx.storeId),
        json: {
          sentAt: api.clock.now().toISOString(),
          anonymousId: uuidv7(),
          sessionId: uuidv7(),
          clientVersion: "1.0.0",
          platform: "devtools",
          events: [
            {
              eventId: uuidv7(),
              name: "app_launch",
              occurredAt: api.clock.now().toISOString(),
              props: { hasInvitation: false },
            },
          ],
        },
      }),
  },
  {
    operationId: "m.subscribeResult.create",
    play: (api: TestApi, ctx: ClerkSampleContext) => {
      const reportId = uuidv7();
      return api.request("/api/v1/m/subscribe-results", {
        method: "POST",
        headers: {
          ...ctx.clerk.withStore(ctx.storeId),
          "Idempotency-Key": `subscribeReport:${reportId}`,
        },
        json: {
          reportId,
          point: "profile_submit",
          results: [{ tmplId: "unknown-template", result: "reject" }],
        },
      });
    },
  },
  {
    operationId: "m.clientError.create",
    expectedStatus: 202,
    play: (api: TestApi, ctx: ClerkSampleContext) => {
      const eventId = uuidv7().replaceAll("-", "");
      return api.request("/api/v1/m/client-errors", {
        method: "POST",
        headers: {
          ...ctx.clerk.withStore(ctx.storeId),
          "Content-Type": "application/x-sentry-envelope",
        },
        body: `${JSON.stringify({ dsn: "https://publickey@example.invalid/7", event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, message: "Example error" })}`,
      });
    },
  },
];
