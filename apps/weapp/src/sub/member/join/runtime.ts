import type { Body, Me, TenantApi } from "../members/api";
export const validInvitationToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
const labels: Readonly<Record<string, string>> = {
  pending: "邀请你加入门店",
  accepted: "邀请已被使用",
  revoked: "邀请已撤回",
  expired: "邀请已过期",
};
export const previewLabel = (status: string) => labels[status] ?? "邀请不可用";
export async function joinLogin(
  api: TenantApi,
  input: {
    phoneCode: string;
    agreed: boolean;
    loginCode(): Promise<string>;
    consents: Body<"m.session.phoneLogin">["consents"];
    current(): boolean;
    attribution?: Body<"m.session.phoneLogin">["attribution"];
  },
) {
  if (!input.agreed || !input.consents.length) throw new Error("请先阅读并勾选当前协议");
  if (!input.phoneCode) throw new Error("请重新授权手机号");
  const code = await input.loginCode();
  if (!input.current()) throw new Error("页面已变化，请重新进入加入页");
  return api.phoneLogin({
    loginCode: code,
    phoneCode: input.phoneCode,
    consents: input.consents,
    consentScene: "member_join",
    ...(input.attribution ? { attribution: input.attribution } : {}),
  });
}

/** 登录后的自有 reload 最多允许一次真实选店；离页、切人或额外切店均不可续作接受。 */
export function joinedLoginScope(
  me: Me,
  before: { currentStoreId: string | null; contextRev: number },
) {
  const stores = me.memberships.flatMap((m) => m.stores);
  const storeId =
    stores.find((s) => s.storeId === before.currentStoreId)?.storeId ??
    me.memberships
      .map((m) => m.lastStoreId)
      .find((id) => id && stores.some((s) => s.storeId === id)) ??
    stores[0]?.storeId ??
    null;
  return { storeId, contextRev: before.contextRev + (before.currentStoreId === storeId ? 0 : 1) };
}
export function ownsJoinedLogin(
  expected: { token: string; storeId: string | null; contextRev: number; pageGeneration: number },
  actual: {
    token: string | null;
    storeId: string | null;
    contextRev: number;
    pageGeneration: number;
    visible: boolean;
  },
) {
  return (
    actual.visible &&
    expected.token === actual.token &&
    expected.storeId === actual.storeId &&
    expected.contextRev === actual.contextRev &&
    expected.pageGeneration === actual.pageGeneration
  );
}
