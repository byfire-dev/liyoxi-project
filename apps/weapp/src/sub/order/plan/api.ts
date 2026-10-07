import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export function createPlanApi(send: RequestLayer["request"]) {
  const base = (id: string) => `/m/delivery-plans/${encodeURIComponent(id)}`;
  return {
    plan: (id: string) => send<Data<"m.deliveryPlan.get">>(base(id)),
    confirmPlan: (id: string, versionNo: number, key: string) =>
      send<Data<"m.deliveryPlan.confirm">>(`${base(id)}/confirm`, {
        method: "POST",
        data: { versionNo },
        idempotencyKey: key,
      }),
    changePlan: (id: string, data: Body<"m.deliveryPlan.requestChange">, key: string) =>
      send<Data<"m.deliveryPlan.requestChange">>(`${base(id)}/request-change`, {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
  };
}
