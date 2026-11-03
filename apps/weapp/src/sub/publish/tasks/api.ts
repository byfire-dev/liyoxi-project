import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import type { operations } from "@liyoxi/contract/types/merchant";
export type LaunchSummaryQuery = NonNullable<
  operations["m.launchTask.summary"]["parameters"]["query"]
>;
export type TakedownQuery = NonNullable<operations["m.takedownTask.list"]["parameters"]["query"]>;
const queryString = (query: object) =>
  Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
export function createTaskWriteApi(send: RequestLayer["request"]) {
  return {
    summary: (query: LaunchSummaryQuery = {}) =>
      send<Data<"m.launchTask.summary">>(
        `/m/launch-tasks/summary${queryString(query) ? `?${queryString(query)}` : ""}`,
      ),
    submit: (id: string, data: Body<"m.launchTask.submit">, key: string) =>
      send<Data<"m.launchTask.submit">>(`/m/launch-tasks/${encodeURIComponent(id)}/submit`, {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
    takedowns: (query: TakedownQuery) =>
      send<Data<"m.takedownTask.list">>(`/m/takedown-tasks?${queryString(query)}`),
    takedownSummary: (orderId?: string) =>
      send<Data<"m.takedownTask.summary">>(
        `/m/takedown-tasks/summary${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
      ),
    confirmTakedown: (id: string, data: Body<"m.takedownTask.confirm">, key: string) =>
      send<Data<"m.takedownTask.confirm">>(`/m/takedown-tasks/${encodeURIComponent(id)}/confirm`, {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
    publishList: (orderItemId: string) =>
      send<Data<"m.orderItem.publishList.get">>(
        `/m/order-items/${encodeURIComponent(orderItemId)}/publish-list`,
      ),
  };
}
