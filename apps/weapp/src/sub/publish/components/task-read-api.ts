import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import type { TaskQuery } from "../../order/components/delivery-api";
export function createTaskReadApi(send: RequestLayer["request"]) {
  return {
    tasks: (query: TaskQuery) => {
      const params = Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      return send<Data<"m.launchTask.list">>(`/m/launch-tasks?${params}`);
    },
    task: (id: string) =>
      send<Data<"m.launchTask.get">>(`/m/launch-tasks/${encodeURIComponent(id)}`),
  };
}
