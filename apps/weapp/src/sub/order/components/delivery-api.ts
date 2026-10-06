import type { operations } from "@liyoxi/contract/types/merchant";
import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export type Plan = Data<"m.deliveryPlan.get">;
export type Sample = Data<"m.orderItem.sample.get">;
export type Release = Data<"m.orderItem.release.get">;
export type TaskPage = Data<"m.launchTask.list">;
export type Task = Data<"m.launchTask.get">;
export type Submit = Body<"m.launchTask.submit">;
export type Change = Body<"m.deliveryPlan.requestChange">;
export type TaskQuery = NonNullable<operations["m.launchTask.list"]["parameters"]["query"]>;
const id = encodeURIComponent;
export function createDeliveryApi(send: RequestLayer["request"]) {
  const post = <K extends keyof operations>(path: string, data: Body<K>, idempotencyKey: string) =>
    send<Data<K>>(path, { method: "POST", data, idempotencyKey });
  return {
    plan: (value: string) => send<Plan>(`/m/delivery-plans/${id(value)}`),
    confirmPlan: (value: string, versionNo: number, key: string) =>
      post<"m.deliveryPlan.confirm">(`/m/delivery-plans/${id(value)}/confirm`, { versionNo }, key),
    changePlan: (value: string, body: Change, key: string) =>
      post<"m.deliveryPlan.requestChange">(
        `/m/delivery-plans/${id(value)}/request-change`,
        body,
        key,
      ),
    sample: (value: string) => send<Sample>(`/m/order-items/${id(value)}/sample`),
    sampleUrl: (value: string) =>
      send<Data<"m.sample.downloadUrls">>(`/m/samples/${id(value)}/download-urls`, {
        method: "POST",
      }),
    confirmSample: (value: string, body: Body<"m.sample.confirm">, key: string) =>
      post<"m.sample.confirm">(`/m/samples/${id(value)}/confirm`, body, key),
    release: (value: string) => send<Release>(`/m/order-items/${id(value)}/release`),
    episodeUrl: (value: string, episodeNo: number) =>
      send<Data<"m.orderItem.downloadUrls">>(`/m/order-items/${id(value)}/download-urls`, {
        method: "POST",
        data: { kind: "episode", episodeNo } satisfies Body<"m.orderItem.downloadUrls">,
      }),
    tasks: (query: TaskQuery) => {
      const params = Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      return send<TaskPage>(`/m/launch-tasks?${params}`);
    },
    summary: () => send<Data<"m.launchTask.summary">>("/m/launch-tasks/summary"),
    task: (value: string) => send<Task>(`/m/launch-tasks/${id(value)}`),
    submit: (value: string, body: Submit, key: string) =>
      post<"m.launchTask.submit">(`/m/launch-tasks/${id(value)}/submit`, body, key),
  };
}
export type DeliveryApi = ReturnType<typeof createDeliveryApi>;
