import { account } from "@/lib/account-runtime";
import { requestPayment } from "@/lib/platform.taro";
import { newIdempotencyKey, withSubscribe } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { billingRequest } from "../wallet/runtime";
import { createTopupApi } from "./api";
import { createTopupModel, purchaseContext } from "./model";
import { createPaymentIntent } from "./payment";

export function currentPurchaseContext(key: "points.topup" | "plan.purchase" = "points.topup") {
  const context = useContextStore.getState();
  return purchaseContext(
    {
      token: useSessionStore.getState().accessToken,
      storeId: context.currentStoreId,
      contextRev: context.contextRev,
      me: account.snapshot().me,
    },
    key,
  );
}
export const topupApi = createTopupApi(billingRequest);
export const topupModel = () =>
  createTopupModel({
    api: topupApi,
    prepare: () => account.start(),
    context: currentPurchaseContext,
  });

export const paymentIntent = (current: () => boolean) =>
  createPaymentIntent({
    api: topupApi,
    current,
    key: () => newIdempotencyKey("wechat-payment"),
    now: () => Date.now(),
    pay: requestPayment,
    onSuccess: withSubscribe("pay_success", () => undefined),
  });
