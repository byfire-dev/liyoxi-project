import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type ApproveBody =
  operations["admin.channelAccountSubmission.approve"]["requestBody"]["content"]["application/json"];
export type RejectBody =
  operations["admin.channelAccountSubmission.reject"]["requestBody"]["content"]["application/json"];
export class AccountFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
async function unwrap<T>(result: { data?: { data: T }; response: Response }): Promise<T> {
  if (result.data) return result.data.data;
  const failure = await readFailure(result.response);
  throw new AccountFailure(failure.message, failure.body?.error);
}
export function createAccountsApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  return {
    list: (tab: "todo" | "done_today", q: string | undefined, page: number) =>
      client
        .GET("/api/v1/admin/approvals", {
          params: { query: { kind: "channel_account", tab, q, page, pageSize: 100, sort: "due" } },
        })
        .then(unwrap),
    summary: (q?: string) =>
      client
        .GET("/api/v1/admin/approvals/summary", {
          params: { query: { kind: "channel_account", q } },
        })
        .then(unwrap)
        .then((data) => data.items.find((item) => item.kind === "channel_account")),
    detail: (id: string) =>
      client
        .GET("/api/v1/admin/channel-account-submissions/{channelAccountSubmissionId}", {
          params: { path: { channelAccountSubmissionId: id } },
        })
        .then(unwrap),
    templates: () =>
      client
        .GET("/api/v1/admin/checklist-templates", {
          params: { query: { code: "account.verify", status: "active" } },
        })
        .then(unwrap)
        .then((data) => data.items.find((item) => item.code === "account.verify")),
    reasons: () =>
      client
        .GET("/api/v1/admin/dict-items", {
          params: { query: { typeKey: "reject_reason", scene: "account_verify" } },
        })
        .then(unwrap)
        .then((data) => data.items.filter((item) => item.isEnabled)),
    approve: (id: string, body: ApproveBody, key: string) =>
      client
        .POST("/api/v1/admin/channel-account-submissions/{channelAccountSubmissionId}/approve", {
          params: { path: { channelAccountSubmissionId: id } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
    reject: (id: string, body: RejectBody, key: string) =>
      client
        .POST("/api/v1/admin/channel-account-submissions/{channelAccountSubmissionId}/reject", {
          params: { path: { channelAccountSubmissionId: id } },
          body,
          headers: { "Idempotency-Key": key },
        })
        .then(unwrap),
  };
}
export type AccountsApi = ReturnType<typeof createAccountsApi>;
export type ApprovalRow = Awaited<ReturnType<AccountsApi["list"]>>["items"][number];
export type AccountDetail = Awaited<ReturnType<AccountsApi["detail"]>>;
export type Template = NonNullable<Awaited<ReturnType<AccountsApi["templates"]>>>;
