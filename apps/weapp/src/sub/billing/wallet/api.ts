import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export function createWalletApi(request: RequestLayer["request"]) {
  return {
    wallet: () => request<Data<"m.wallet.get">>("/m/wallet"),
    policy: () => request<Data<"m.purchasePolicy.get">>("/m/purchase-policy"),
    plans: () => request<Data<"m.plan.list">>("/m/plans"),
  };
}
