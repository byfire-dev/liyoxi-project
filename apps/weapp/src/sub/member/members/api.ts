import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type Stores = Data<"m.store.list">;
export type Members = Data<"m.member.list">;
export type Invitation = Data<"m.invitation.create">;
export type Preview = Data<"m.invitation.lookup">;
export type Store = Stores["items"][number];
export type OwnerStores = Extract<Stores, { viewerRole: "owner" }>;
export type OwnerMembers = Extract<Members, { viewerRole: "owner" }>;
export type Member = OwnerMembers["items"][number];
export type Me = Data<"m.me.get">;
export type Result = Data<"m.invitation.accept">;
export type { Body, Data };

/** 六页唯一生产调用仍为中央request；离线样张仅注入同形调用。 */
export function createTenantApi(call: RequestLayer["request"]) {
  const id = encodeURIComponent;
  return {
    me: () => call<Me>("/m/me", { store: false }),
    stores: () => call<Stores>("/m/stores", { store: false }),
    createStore: (data: Body<"m.store.create">, key: string) =>
      call<Data<"m.store.create">>("/m/stores", { method: "POST", data, idempotencyKey: key }),
    archive: (storeId: string, key: string) =>
      call<Data<"m.store.archive">>(`/m/stores/${id(storeId)}/archive`, {
        method: "POST",
        idempotencyKey: key,
      }),
    removeStore: (storeId: string, key: string) =>
      call<Data<"m.store.delete">>(`/m/stores/${id(storeId)}/delete`, {
        method: "POST",
        idempotencyKey: key,
      }),
    restore: (storeId: string, key: string) =>
      call<Data<"m.store.restore">>(`/m/stores/${id(storeId)}/restore`, {
        method: "POST",
        idempotencyKey: key,
      }),
    members: () => call<Members>("/m/members"),
    updateMember: (memberId: string, data: Body<"m.member.update">, key: string) =>
      call<Data<"m.member.update">>(`/m/members/${id(memberId)}`, {
        method: "PATCH",
        data,
        idempotencyKey: key,
      }),
    removeMember: (memberId: string, key: string) =>
      call<Data<"m.member.remove">>(`/m/members/${id(memberId)}/remove`, {
        method: "POST",
        idempotencyKey: key,
      }),
    leave: (key: string) =>
      call<Data<"m.me.membership.leave">>("/m/me/membership/leave", {
        method: "POST",
        idempotencyKey: key,
      }),
    invite: (data: Body<"m.invitation.create">) =>
      call<Invitation>("/m/invitations", { method: "POST", data }),
    markShared: (invitationId: string, key: string) =>
      call<Data<"m.invitation.markShared">>(`/m/invitations/${id(invitationId)}/mark-shared`, {
        method: "POST",
        idempotencyKey: key,
      }),
    revoke: (invitationId: string, reason: "by_owner" | "unshared_leave", key: string) =>
      call<Data<"m.invitation.revoke">>(`/m/invitations/${id(invitationId)}/revoke`, {
        method: "POST",
        data: { reason },
        idempotencyKey: key,
      }),
    lookup: (token: string) =>
      call<Preview>(`/m/invitations/lookup?token=${id(token)}`, { auth: false, store: false }),
    accept: (invitationId: string, data: Body<"m.invitation.accept">, key: string) =>
      call<Result>(`/m/invitations/${id(invitationId)}/accept`, {
        method: "POST",
        data,
        idempotencyKey: key,
        store: false,
      }),
    agreements: () =>
      call<Data<"m.agreement.list">>("/m/agreements?scene=member_join&limit=50", {
        auth: false,
        store: false,
      }),
    phoneLogin: (data: Body<"m.session.phoneLogin">) =>
      call<Data<"m.session.phoneLogin">>("/m/sessions/phone-login", {
        method: "POST",
        data,
        auth: false,
        store: false,
      }),
    profile: () => call<Data<"m.storeProfile.get">>("/m/store-profile"),
    assetSummary: () => call<Data<"m.storeAsset.summary">>("/m/store-assets/summary?uploader=me"),
    demands: () => call<Data<"m.assetDemand.list">>("/m/asset-demands?status=open&limit=20"),
    service: () => call<Data<"m.storeProfile.service.get">>("/m/store-profile/service"),
    brandSummary: () =>
      call<Data<"m.storeAsset.summary">>("/m/store-assets/summary?tag=brand_story"),
    dict: async (typeKey: string, parentCode?: string) =>
      (
        await call<Data<"m.dictItem.list">>(
          `/m/dict-items?typeKey=${id(typeKey)}${parentCode ? `&parentCode=${id(parentCode)}` : ""}`,
        )
      ).items[0]?.items ?? [],
  };
}
export type TenantApi = ReturnType<typeof createTenantApi>;
