import type { components, operations } from "@liyoxi/contract/types/merchant";
import type { RequestLayer } from "../request";
type Data<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer T } } } };
}
  ? T
  : never;
export type Registration = components["schemas"]["FileRegistration"];
export type FileStatus = components["schemas"]["FileStatusView"];
export type RegisterBody =
  operations["m.file.create"]["requestBody"]["content"]["application/json"];
export function createUploadApi(call: RequestLayer["request"]) {
  const path = (id: string) => `/m/files/${encodeURIComponent(id)}`;
  return {
    register: (data: RegisterBody) =>
      call<Data<"m.file.create">>("/m/files", { method: "POST", data }),
    get: (id: string) => call<FileStatus>(path(id)),
    complete: (id: string, idempotencyKey: string) =>
      call<FileStatus>(`${path(id)}/complete`, { method: "POST", idempotencyKey }),
    refresh: (id: string) =>
      call<Registration>(`${path(id)}/refresh-credentials`, { method: "POST" }),
    cancel: (id: string, idempotencyKey: string) =>
      call<FileStatus>(`${path(id)}/cancel`, { method: "POST", idempotencyKey }),
  };
}
export type UploadApi = ReturnType<typeof createUploadApi>;
