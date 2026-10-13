import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";
export type Query<K extends keyof operations> = operations[K] extends {
  parameters: { query?: infer Q };
}
  ? NonNullable<Q>
  : never;
export type Body<K extends keyof operations> = operations[K] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;
export class MerchantFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details: unknown,
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
  const failure = await readFailure(
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        }),
  );
  throw new MerchantFailure(failure.message, failure.symbol, failure.status, failure.body?.details);
}
export function createMerchantApi({ api }: Pick<AppServices, "api">) {
  const c = api.client,
    headers = (key: string) => ({ "Idempotency-Key": key });
  return {
    stores: (query: Query<"admin.store.list">) =>
      c.GET("/api/v1/admin/stores", { params: { query } }).then(unwrap),
    summary: (query: Query<"admin.store.summary">) =>
      c.GET("/api/v1/admin/stores/summary", { params: { query } }).then(unwrap),
    store: (storeId: string) =>
      c.GET("/api/v1/admin/stores/{storeId}", { params: { path: { storeId } } }).then(unwrap),
    profile: (storeId: string) =>
      c
        .GET("/api/v1/admin/stores/{storeId}/profile", { params: { path: { storeId } } })
        .then(unwrap),
    qualification: (storeId: string) =>
      c
        .GET("/api/v1/admin/stores/{storeId}/qualification", { params: { path: { storeId } } })
        .then(unwrap),
    activity: (storeId: string, query: Query<"admin.store.activity.list">) =>
      c
        .GET("/api/v1/admin/stores/{storeId}/activities", { params: { path: { storeId }, query } })
        .then(unwrap),
    entity: (entityId: string) =>
      c.GET("/api/v1/admin/entities/{entityId}", { params: { path: { entityId } } }).then(unwrap),
    members: (entityId: string, query: Query<"admin.entity.member.list"> = {}) =>
      c
        .GET("/api/v1/admin/entities/{entityId}/members", { params: { path: { entityId }, query } })
        .then(unwrap),
    follows: (query: Query<"admin.followUp.list">) =>
      c.GET("/api/v1/admin/follow-ups", { params: { query } }).then(unwrap),
    requests: (query: Query<"admin.accountChangeRequest.list">) =>
      c.GET("/api/v1/admin/account-change-requests", { params: { query } }).then(unwrap),
    request: (accountChangeRequestId: string) =>
      c
        .GET("/api/v1/admin/account-change-requests/{accountChangeRequestId}", {
          params: { path: { accountChangeRequestId } },
        })
        .then(unwrap),
    staff: (query: Query<"admin.staff.list">) =>
      c.GET("/api/v1/admin/staff", { params: { query } }).then(unwrap),
    dict: (query: Query<"admin.dictItem.list">) =>
      c.GET("/api/v1/admin/dict-items", { params: { query } }).then(unwrap),
    editProfile: (storeId: string, body: Body<"admin.store.profile.update">, key: string) =>
      c
        .PATCH("/api/v1/admin/stores/{storeId}/profile", {
          params: { path: { storeId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    assign: (storeId: string, body: Body<"admin.store.assignDeliveryManager">, key: string) =>
      c
        .POST("/api/v1/admin/stores/{storeId}/assign-delivery-manager", {
          params: { path: { storeId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    transfer: (storeId: string, body: Body<"admin.store.reassignDeliveryManager">, key: string) =>
      c
        .POST("/api/v1/admin/stores/{storeId}/reassign-delivery-manager", {
          params: { path: { storeId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    contacted: (
      assignmentHistoryId: string,
      body: Body<"admin.assignmentHistory.markContacted">,
      key: string,
    ) =>
      c
        .POST("/api/v1/admin/assignment-histories/{assignmentHistoryId}/mark-contacted", {
          params: { path: { assignmentHistoryId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    quota: (entityId: string, body: Body<"admin.entity.quota.update">, key: string) =>
      c
        .PATCH("/api/v1/admin/entities/{entityId}/quota", {
          params: { path: { entityId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    close: (entityId: string, body: Body<"admin.entity.close">, key: string) =>
      c
        .POST("/api/v1/admin/entities/{entityId}/close", {
          params: { path: { entityId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    disable: (merchantUserId: string, body: Body<"admin.merchantUser.disable">, key: string) =>
      c
        .POST("/api/v1/admin/merchant-users/{merchantUserId}/disable", {
          params: { path: { merchantUserId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    enable: (merchantUserId: string, body: Body<"admin.merchantUser.enable">, key: string) =>
      c
        .POST("/api/v1/admin/merchant-users/{merchantUserId}/enable", {
          params: { path: { merchantUserId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    logout: (merchantUserId: string, body: Body<"admin.merchantUser.forceLogout">, key: string) =>
      c
        .POST("/api/v1/admin/merchant-users/{merchantUserId}/force-logout", {
          params: { path: { merchantUserId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    createFollow: (body: Body<"admin.followUp.create">, key: string) =>
      c.POST("/api/v1/admin/follow-ups", { body, headers: headers(key) }).then(unwrap),
    updateFollow: (followUpId: string, body: Body<"admin.followUp.update">, key: string) =>
      c
        .PATCH("/api/v1/admin/follow-ups/{followUpId}", {
          params: { path: { followUpId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    completeFollow: (followUpId: string, body: Body<"admin.followUp.complete">, key: string) =>
      c
        .POST("/api/v1/admin/follow-ups/{followUpId}/complete", {
          params: { path: { followUpId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    createRequest: (body: Body<"admin.accountChangeRequest.create">, key: string) =>
      c.POST("/api/v1/admin/account-change-requests", { body, headers: headers(key) }).then(unwrap),
    approveRequest: (
      accountChangeRequestId: string,
      body: Body<"admin.accountChangeRequest.approve">,
      key: string,
    ) =>
      c
        .POST("/api/v1/admin/account-change-requests/{accountChangeRequestId}/approve", {
          params: { path: { accountChangeRequestId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    rejectRequest: (
      accountChangeRequestId: string,
      body: Body<"admin.accountChangeRequest.reject">,
      key: string,
    ) =>
      c
        .POST("/api/v1/admin/account-change-requests/{accountChangeRequestId}/reject", {
          params: { path: { accountChangeRequestId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    withdrawRequest: (
      accountChangeRequestId: string,
      body: Body<"admin.accountChangeRequest.withdraw">,
      key: string,
    ) =>
      c
        .POST("/api/v1/admin/account-change-requests/{accountChangeRequestId}/withdraw", {
          params: { path: { accountChangeRequestId } },
          body,
          headers: headers(key),
        })
        .then(unwrap),
    download: (fileId: string) =>
      c
        .POST("/api/v1/admin/files/{fileId}/download-urls", {
          params: { path: { fileId } },
          body: { disposition: "inline", purpose: "商家详情核对" },
        })
        .then(unwrap),
  };
}
export type MerchantApi = ReturnType<typeof createMerchantApi>;
export type StoreRow = Awaited<ReturnType<MerchantApi["stores"]>>["items"][number];
export type StoreHeader = Awaited<ReturnType<MerchantApi["store"]>>;
export type Profile = Awaited<ReturnType<MerchantApi["profile"]>>;
export type Entity = Awaited<ReturnType<MerchantApi["entity"]>>;
export type Member = Awaited<ReturnType<MerchantApi["members"]>>["items"][number];
export type Follow = Awaited<ReturnType<MerchantApi["follows"]>>["items"][number];
export type AccountRequest = Awaited<ReturnType<MerchantApi["request"]>>;
