import Taro from "@tarojs/taro";
import { useContextStore } from "../src/stores/context";
import { useSessionStore } from "../src/stores/session";
import {
  createTenantApi,
  type Body,
  type Data,
  type OwnerStores,
  type TenantRuntime,
} from "../src/sub/member/members/api";
import type { RequestLayer } from "../src/lib/request";
import { dicts } from "./profile-fixtures";
import {
  TENANT_NEW,
  TENANT_NOW,
  tenantAgreements,
  tenantAssetSummary,
  tenantDemands,
  tenantInvitation,
  tenantMe,
  tenantMembers,
  tenantPreview,
  tenantProfile,
  tenantResult,
  tenantStores,
  tenantService,
  tenantFixtureIds,
} from "./tenant-data";
type Call = {
  path: string;
  method: string;
  data: unknown;
  key?: string;
  store?: boolean;
  auth?: boolean;
};
const runtimes = new Map<string, TenantRuntime>();
/** 仅由 H5 显式截图标记装载；不识别普通 URL，不回退网络。 */
export function offlineTenantRuntime(scene: string): TenantRuntime {
  const previous = runtimes.get(scene);
  if (previous) return previous;
  const clerk = scene === "tenant-staff-profile" || scene === "tenant-stores-clerk";
  let stores = tenantStores(clerk),
    members = tenantMembers(clerk);
  let invitation = structuredClone(tenantInvitation);
  let status =
    scene === "tenant-join-expired"
      ? ("expired" as const)
      : ("pending" as "pending" | "accepted" | "revoked" | "expired");
  const calls: Call[] = [];
  (globalThis as { __LYX_TENANT_CALLS__?: Call[] }).__LYX_TENANT_CALLS__ = calls;
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ): Promise<T> => {
    const method = options?.method ?? "GET";
    calls.push({
      path,
      method,
      data: options?.data,
      key: options?.idempotencyKey,
      store: options?.store,
      auth: options?.auth,
    });
    let data: unknown;
    if (path === "/m/me") data = tenantMe(clerk);
    else if (path === "/m/stores" && method === "GET") data = stores;
    else if (path === "/m/members" && method === "GET") data = members;
    else if (path.startsWith("/m/agreements?")) data = tenantAgreements;
    else if (path.startsWith("/m/invitations/lookup?")) data = tenantPreview(status);
    else if (path === "/m/invitations" && method === "POST") {
      const body = options?.data as Body<"m.invitation.create">;
      invitation = {
        ...invitation,
        isReused: calls.filter((c) => c.path === path).length > 1,
        remarkName: body.remarkName ?? null,
        isPhoneRestricted: Boolean(body.targetPhone),
      };
      data = invitation;
    } else if (path.endsWith("/mark-shared"))
      data = {
        invitationId: invitation.invitationId,
        sharedAt: TENANT_NOW,
      } satisfies Data<"m.invitation.markShared">;
    else if (path.endsWith("/revoke")) {
      status = "revoked";
      data = {
        invitationId: invitation.invitationId,
        status,
        revokedAt: TENANT_NOW,
      } satisfies Data<"m.invitation.revoke">;
    } else if (path.endsWith("/accept")) {
      status = "accepted";
      data = tenantResult;
    } else if (path === "/m/sessions/phone-login")
      data = {
        token: "lyxm_offline_tenant",
        me: tenantMe(true),
        isNewUser: false,
        switchedFrom: null,
      } satisfies Data<"m.session.phoneLogin">;
    else if (path === "/m/store-profile") data = tenantProfile(clerk);
    else if (path.startsWith("/m/store-assets/summary?")) data = tenantAssetSummary;
    else if (path.startsWith("/m/asset-demands?")) data = tenantDemands;
    else if (path === "/m/store-profile/service") data = tenantService;
    else if (path.startsWith("/m/dict-items?")) {
      const key = new URL(path, "https://fixture.invalid").searchParams.get("typeKey");
      data = { items: dicts.items.filter((d) => d.typeKey === key) };
    } else if (path === "/m/stores" && method === "POST") {
      if (stores.viewerRole !== "owner") throw new Error("owner fixture required");
      const body = options?.data as Body<"m.store.create">;
      const card: OwnerStores["items"][number] = {
        ...stores.items[1]!,
        storeId: TENANT_NEW,
        name: body.name,
        isPrimary: false,
        actions: ["delete"],
      };
      stores = {
        ...stores,
        items: [...stores.items, card],
        entity: { ...stores.entity, storesUsed: stores.entity.storesUsed + 1 },
      };
      data = card;
    } else if (path.startsWith("/m/members/") && method === "PATCH") {
      if (members.viewerRole !== "owner") throw new Error("owner fixture required");
      const memberId = path.split("/")[3],
        body = options?.data as Body<"m.member.update">;
      const item = members.items.find((m) => m.memberId === memberId);
      if (!item) throw new Error("unknown fixture member");
      const updated = {
        ...item,
        stores: item.stores.filter((s) => body.storeIds.includes(s.storeId)),
      };
      members = { ...members, items: members.items.map((m) => (m === item ? updated : m)) };
      data = updated;
    } else throw new Error(`未知本域离线请求：${method} ${path}`);
    return structuredClone(data) as T;
  };
  const runtime: TenantRuntime = {
    api: createTenantApi(call),
    loginCode: async () => "fixture_login_code",
    attribution: () => ({}),
    async selectResult(storeId, current, route = "sub/profile/profile/index", alive) {
      if (!current() || !alive()) return;
      if (scene === "tenant-store-add") throw new Error("选店暂不可用，请继续进入已创建的门店");
      if (!stores.items.some((s) => s.storeId === storeId))
        throw new Error("fixture store unavailable");
      const me = tenantMe(clerk);
      me.memberships[0]!.stores = stores.items.map(
        ({ storeId, name, isPrimary, lifecycle, qualificationStatus }) => ({
          storeId,
          name,
          isPrimary,
          lifecycle,
          qualificationStatus,
        }),
      );
      me.memberships[0]!.lastStoreId = storeId;
      useSessionStore.getState().setMe(me);
      useContextStore.getState().switchStore(storeId);
      // 目标为同域六页时保留相同显式 H5 标记；原档案由其既有私有样张接管。
      if (route === "sub/profile/profile/index")
        (globalThis as { __LYX_PROFILE_SHOT__?: string }).__LYX_PROFILE_SHOT__ = "profile-owner";
      await Taro.redirectTo({ url: `/${route}?storeId=${encodeURIComponent(storeId)}` });
    },
  };
  runtimes.set(scene, runtime);
  // 原账户样张仍用v4；仅本域显式H5上下文同步同源v7，旧场景一字不改。
  if (useSessionStore.getState().accessToken) {
    useSessionStore.getState().setMe(tenantMe(clerk));
    const current = useContextStore.getState().currentStoreId;
    if (current) useContextStore.getState().switchStore(tenantFixtureIds(current));
  }
  return runtime;
}
