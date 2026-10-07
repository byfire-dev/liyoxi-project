import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
export function createTaskWriteApi(send: RequestLayer["request"]) {
  return {
    summary: () => send<Data<"m.launchTask.summary">>("/m/launch-tasks/summary"),
    submit: (id: string, data: Body<"m.launchTask.submit">, key: string) =>
      send<Data<"m.launchTask.submit">>(`/m/launch-tasks/${encodeURIComponent(id)}/submit`, {
        method: "POST",
        data,
        idempotencyKey: key,
      }),
  };
}
