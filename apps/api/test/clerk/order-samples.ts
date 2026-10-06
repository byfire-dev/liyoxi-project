import { uuidv7 } from "@liyoxi/services";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";
type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string; agreementVersionId: string };

const dramaId = uuidv7();
export const orderClerkSamples = [
  ...[
    ["m.cartItem.list", "/m/cart-items"],
    ["m.order.list", "/m/orders"],
    ["m.order.get", `/m/orders/${uuidv7()}`],
    ["m.orderItem.list", "/m/order-items"],
    ["m.orderItem.summary", "/m/order-items/summary"],
    ["m.orderItem.get", `/m/order-items/${uuidv7()}`],
  ].map(([operationId, path]) => ({
    operationId: operationId!,
    play: (api: TestApi, context: ClerkSampleContext) =>
      api.request(`/api/v1${path}`, { headers: context.clerk.withStore(context.storeId) }),
  })),
  {
    operationId: "m.cartItem.create",
    play: (api: TestApi, context: ClerkSampleContext) =>
      api.request("/api/v1/m/cart-items", {
        method: "POST",
        json: { dramaId },
        headers: context.clerk.withStore(context.storeId),
      }),
  },
  {
    operationId: "m.cartItem.delete",
    play: (api: TestApi, context: ClerkSampleContext) =>
      api.request(`/api/v1/m/cart-items/${uuidv7()}`, {
        method: "DELETE",
        headers: { ...context.clerk.withStore(context.storeId), "Idempotency-Key": uuidv7() },
      }),
  },
  {
    operationId: "m.cartItem.acceptPrice",
    play: (api: TestApi, context: ClerkSampleContext) =>
      api.request(`/api/v1/m/cart-items/${uuidv7()}/accept-price`, {
        method: "POST",
        json: { acceptedPricePoints: 100 },
        headers: { ...context.clerk.withStore(context.storeId), "Idempotency-Key": uuidv7() },
      }),
  },
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
