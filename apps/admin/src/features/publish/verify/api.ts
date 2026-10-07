import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type ApproveBody =
  operations["admin.launchSubmission.approve"]["requestBody"]["content"]["application/json"];
export type RejectBody =
  operations["admin.launchSubmission.reject"]["requestBody"]["content"]["application/json"];
export class VerifyFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
async function unwrap<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  if (
    typeof result.error === "object" &&
    result.error &&
    "error" in result.error &&
    "message" in result.error &&
    typeof result.error.error === "string" &&
    typeof result.error.message === "string"
  )
    throw new VerifyFailure(result.error.message, result.error.error);
  const failure = await readFailure(result.response);
  throw new VerifyFailure(failure.message, failure.symbol);
}
export function createVerifyApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (tab: "todo" | "done_today", q: string | undefined, page: number) =>
      client
        .GET("/api/v1/admin/approvals", {
          params: { query: { kind: "launch_link", tab, q, page, pageSize: 100, sort: "due" } },
        })
        .then(unwrap),
    summary: (q?: string) =>
      client
        .GET("/api/v1/admin/approvals/summary", { params: { query: { kind: "launch_link", q } } })
        .then(unwrap)
        .then((data) => data.items.find((item) => item.kind === "launch_link")),
    detail: (id: string) =>
      client
        .GET("/api/v1/admin/launch-submissions/{launchSubmissionId}", {
          params: { path: { launchSubmissionId: id } },
        })
        .then(unwrap),
    template: () =>
      client
        .GET("/api/v1/admin/checklist-templates", {
          params: { query: { code: "launch.verify", status: "active" } },
        })
        .then(unwrap)
        .then((data) => data.items.find((item) => item.code === "launch.verify")),
    reasons: () =>
      client
        .GET("/api/v1/admin/dict-items", {
          params: { query: { typeKey: "reject_reason", scene: "link_verify" } },
        })
        .then(unwrap)
        .then((data) => data.items.filter((item) => item.isEnabled)),
    approve: (id: string, body: ApproveBody, key: string) =>
      client
        .POST("/api/v1/admin/launch-submissions/{launchSubmissionId}/approve", {
          params: { path: { launchSubmissionId: id } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    reject: (id: string, body: RejectBody, key: string) =>
      client
        .POST("/api/v1/admin/launch-submissions/{launchSubmissionId}/reject", {
          params: { path: { launchSubmissionId: id } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
  };
}
export type VerifyApi = ReturnType<typeof createVerifyApi>;
export type VerifyDetail = Awaited<ReturnType<VerifyApi["detail"]>>;
export type Template = NonNullable<Awaited<ReturnType<VerifyApi["template"]>>>;
