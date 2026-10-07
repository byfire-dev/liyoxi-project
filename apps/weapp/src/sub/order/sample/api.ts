import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export function createSampleApi(send: RequestLayer["request"]) {
  const base = (id: string) => `/m/samples/${encodeURIComponent(id)}`;
  return {
    sample: (id: string) =>
      send<Data<"m.orderItem.sample.get">>(`/m/order-items/${encodeURIComponent(id)}/sample`),
    sampleUrl: (id: string) =>
      send<Data<"m.sample.downloadUrls">>(`${base(id)}/download-urls`, { method: "POST" }),
    confirmSample: (id: string, data: Body<"m.sample.confirm">, key: string) =>
      send<Data<"m.sample.confirm">>(`${base(id)}/confirm`, {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
  };
}
