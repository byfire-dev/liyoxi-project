import { uuidv7 } from "@liyoxi/services";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";
type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string; agreementVersionId: string };

const dramaId = uuidv7();
export const orderClerkSamples = [
  {
    operationId: "m.order.quote",
    play: (api: TestApi, context: ClerkSampleContext) =>
      api.request("/api/v1/m/orders/quote", {
        method: "POST",
        json: { dramaIds: [dramaId], isTopModel: false },
        headers: context.clerk.withStore(context.storeId),
      }),
  },
  {
    operationId: "m.order.create",
    play: (api: TestApi, context: ClerkSampleContext) =>
      api.request("/api/v1/m/orders", {
        method: "POST",
        json: {
          dramaIds: [dramaId],
          channelAccountIds: [uuidv7()],
          focusCodes: ["service"],
          isTopModel: false,
          agreementVersionId: context.agreementVersionId,
          expect: { totalChargePoints: 100, items: [{ dramaId, chargePoints: 100 }] },
        },
        headers: { ...context.clerk.withStore(context.storeId), "Idempotency-Key": uuidv7() },
      }),
  },
];
