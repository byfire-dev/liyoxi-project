import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
let offline: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_PUBLISH_SHOT__?: string }).__LYX_PUBLISH_SHOT__;
    if (scene) {
      offline ??= (await import("../../../../shots/publish-fixtures")).offlinePublishRequest(scene);
      return offline(path, options);
    }
  }
  return request(path, options);
};
export function createPublishApi(send: RequestLayer["request"]) {
  return {
    list: (cursor?: string) =>
      send<Data<"m.channelAccount.list">>(
        `/m/channel-accounts?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    create: (data: Body<"m.channelAccount.create">, idempotencyKey: string) =>
      send<Data<"m.channelAccount.create">>("/m/channel-accounts", {
        method: "POST",
        data,
        idempotencyKey,
      }),
    submit: (id: string, data: Body<"m.channelAccount.submit">, idempotencyKey: string) =>
      send<Data<"m.channelAccount.submit">>(
        `/m/channel-accounts/${encodeURIComponent(id)}/submit`,
        { method: "POST", data, idempotencyKey },
      ),
  };
}
export const publishApi = createPublishApi(call);
