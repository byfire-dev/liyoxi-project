import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export function createReleaseApi(send: RequestLayer["request"]) {
  const base = (id: string) => `/m/order-items/${encodeURIComponent(id)}`;
  return {
    release: (id: string) => send<Data<"m.orderItem.release.get">>(`${base(id)}/release`),
    episodeUrl: (id: string, episodeNo: number) =>
      send<Data<"m.orderItem.downloadUrls">>(`${base(id)}/download-urls`, {
        method: "POST",
        data: { kind: "episode", episodeNo } satisfies Body<"m.orderItem.downloadUrls">,
      }),
  };
}
