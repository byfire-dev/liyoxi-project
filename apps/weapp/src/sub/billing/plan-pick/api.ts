import type { Body, Data, Agreement } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export function createPurchaseApi(call: RequestLayer["request"]) {
  return {
    plans: () => call<Data<"m.plan.list">>("/m/plans"),
    policy: () => call<Data<"m.purchasePolicy.get">>("/m/purchase-policy"),
    quote: (data: Body<"m.plan.quote">) =>
      call<Data<"m.plan.quote">>("/m/plans/quote", { method: "POST", data }),
    async agreements() {
      const items: Agreement[] = [];
      let cursor: string | null = null;
      do {
        const page: Data<"m.agreement.list"> = await call(
          `/m/agreements?scene=plan_purchase&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        items.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor);
      return items;
    },
    create: (data: Body<"m.paymentOrder.create">, key: string) =>
      call<Data<"m.paymentOrder.create">>("/m/payment-orders", {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
    detail: (id: string) =>
      call<Data<"m.paymentOrder.get">>(`/m/payment-orders/${encodeURIComponent(id)}`),
    prepay: (id: string, key: string) =>
      call<Data<"m.paymentOrder.wechatPrepay">>(
        `/m/payment-orders/${encodeURIComponent(id)}/wechat-prepay`,
        {
          method: "POST",
          idempotencyKey: key,
        },
      ),
    sync: (id: string) =>
      call<Data<"m.paymentOrder.sync">>(`/m/payment-orders/${encodeURIComponent(id)}/sync`, {
        method: "POST",
      }),
    cancel: (id: string, key: string) =>
      call<Data<"m.paymentOrder.cancel">>(`/m/payment-orders/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        idempotencyKey: key,
      }),
    proof: (id: string, fileId: string, key: string) =>
      call<Data<"m.paymentOrder.transferProof.create">>(
        `/m/payment-orders/${encodeURIComponent(id)}/transfer-proofs`,
        {
          method: "POST",
          data: { fileId } satisfies Body<"m.paymentOrder.transferProof.create">,
          idempotencyKey: key,
        },
      ),
  };
}
export type PurchaseApi = ReturnType<typeof createPurchaseApi>;
