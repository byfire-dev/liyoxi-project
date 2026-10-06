import type { components } from "@liyoxi/contract/types/merchant";

import type { Data, Me, PendingConsent, StoreList } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-10-06T00:00:00.000Z";
export const pending: PendingConsent = {
  agreementKey: "user_terms",
  agreementVersionId: ID,
  name: "商家服务协议",
  versionLabel: "v2.0",
  effectiveAt: NOW,
  summary: "本次更新明确了短剧定制服务流程与账号使用约定，请阅读后确认。",
};
export const bootstrap: Data<"m.bootstrap.get"> = {
  serverTime: NOW,
  minClientVersion: "0.0.0",
  flags: {},
  versions: { agreement: "v2.0", dict: {}, site: {} },
  pendingConsents: null,
  subscribePlan: null,
  subscribeCooldownDays: 7,
  subscribeMaxPerAsk: 3,
  uploadLimits: { weappVideoMaxMb: 100, imageMaxMb: 5 },
  download: { weappSaveMode: "temp" },
  support: { mode: "contact", corpId: null, kfUrl: null },
  copy: {},
  notice: null,
  context: null,
  degraded: [],
};
export const agreements: Data<"m.agreement.list"> = {
  items: [
    {
      agreementKey: "user_terms",
      subjectKind: "user",
      consentMode: "checkbox",
      scenes: ["login"],
      name: "商家服务协议",
      currentVersion: {
        agreementVersionId: ID,
        versionLabel: "v2.0",
        effectiveAt: NOW,
        summary: "商家账号与短剧服务约定",
        isReconsentRequired: true,
      },
      upcomingVersion: null,
    },
    {
      agreementKey: "privacy",
      subjectKind: "user",
      consentMode: "checkbox",
      scenes: ["login"],
      name: "隐私政策",
      currentVersion: {
        agreementVersionId: ID2,
        versionLabel: "v1.0",
        effectiveAt: NOW,
        summary: "个人信息保护说明",
        isReconsentRequired: false,
      },
      upcomingVersion: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
};
export const agreement: Data<"m.agreementVersion.get"> = {
  ...pending,
  major: 2,
  minor: 0,
  phase: "current",
  isReconsentRequired: true,
  contentSha256: "0".repeat(64),
  pdf: { url: "", expiresAt: NOW },
  contentHtml:
    "<h2>商家服务协议</h2><p>欢迎使用狸有戏。请在使用服务前仔细阅读本协议。</p><h3>一、服务内容</h3><p>平台提供自有版权短剧的门店定制服务，具体服务内容与交付范围以双方确认的方案为准。</p><h3>二、账号使用</h3><p>请妥善保管账号。账号信息发生变化时，应及时更新并保持真实、准确。</p><h3>三、素材与发布</h3><p>商家应确保提供的门店信息与广告素材具有合法使用权限，并按平台规则发布交付成片。</p><h3>四、联系我们</h3><p>如对本协议有疑问，可通过服务渠道联系平台。</p>",
};
const membershipStore = (second = false): components["schemas"]["MembershipStore"] => ({
  storeId: second ? ID2 : ID,
  name: second ? "南山店" : "邻里咖啡 · 福田店",
  isPrimary: !second,
  lifecycle: "active",
  qualificationStatus: "verified",
});
export const makeMe = (clerk = false, needsConsent = false): Me => ({
  user: {
    merchantUserId: ID,
    displayName: "林店长",
    phoneMask: "138****8000",
    registeredAt: NOW,
    actions: ["update", "change-phone", "deletion"],
  },
  memberships: [
    {
      memberId: ID,
      role: clerk ? "clerk" : "owner",
      memberDisplayName: "林店长",
      joinedAt: NOW,
      lastStoreId: ID,
      entity: { entityId: ID, name: "邻里咖啡", verificationStatus: "verified" },
      stores: [membershipStore(), membershipStore(true)],
    },
  ],
  pendingConsents: needsConsent ? [pending] : [],
  notices: [],
});
const baseStore = (second = false): components["schemas"]["OverviewStoreForClerk"] => ({
  ...membershipStore(second),
  city: { code: "shenzhen", name: "深圳" },
  category: { code: "coffee", name: "咖啡饮品" },
  role: "owner",
  assetCount: 12,
  clerkCount: 2,
});
export const makeOverview = (clerk = false, second = false): Data<"m.me.overview.get"> =>
  clerk
    ? {
        viewerRole: "clerk",
        currentStore: { ...baseStore(second), role: "clerk" },
        stores: { visibleCount: 2 },
        unreadMessageCount: 0,
      }
    : {
        viewerRole: "owner",
        currentStore: { ...baseStore(second), completenessPct: 100, review: null },
        stores: { visibleCount: 2, storeLimit: 3, reviewingStores: [] },
        subscription: {
          status: "active",
          isRefundPending: false,
          planName: "成长套餐",
          endDate: "2027-04-05",
          remainingDays: 181,
          spendablePoints: 360,
          planAvailablePoints: 300,
          addonAvailablePoints: 60,
          planPointsExpireAt: "2026-11-05",
          isAddonSuspended: false,
        },
        storeStats: { liveCount: 3, deliveringCount: 1, cartCount: 2 },
        entries: {
          hasLaunchTasks: false,
          launchTaskTodoCount: 0,
          channelAccountCount: 0,
          channelAccountAttention: null,
          adPendingConfirmCount: 0,
          ticketAwaitingConfirmCount: 0,
        },
        unreadMessageCount: 0,
      };
export const makeStores = (clerk = false): StoreList => {
  const items = [false, true].map(
    (second) =>
      ({
        ...baseStore(second),
        isLastSelected: !second,
        todoCount: 0,
        actions: [],
      }) satisfies components["schemas"]["StoreCardForClerk"],
  );
  return clerk
    ? {
        viewerRole: "clerk",
        entity: { entityId: ID, name: "邻里咖啡", verificationStatus: "verified" },
        items,
      }
    : {
        viewerRole: "owner",
        entity: {
          entityId: ID,
          name: "邻里咖啡",
          verificationStatus: "verified",
          subscription: { planName: "成长套餐", endDate: "2027-04-05", isActive: true },
          storesUsed: 2,
          storeLimit: 3,
          seatsUsed: 3,
          memberLimit: 5,
          pendingInvitationCount: 0,
          storesOver: 0,
          seatsOver: 0,
          limitReason: "plan",
          canAddStore: true,
        },
        items: items.map((item) => ({
          ...item,
          archiveReason: null,
          archivedAt: null,
          completenessPct: 100,
          deliveringCount: 1,
          expectedDecisionAt: null,
          liveCount: 3,
          memberPreview: [],
          pendingInvitationCount: 0,
          submittedAt: NOW,
          verifiedAt: NOW,
        })),
      };
};

/** 独立固定 DTO 注入，只供离线样张；不发网络，不替代生产 request。 */
export function offlineAccountRequest(scene: string): RequestLayer["request"] {
  let accepted = false;
  let second = false;
  const clerk = scene === "mine-clerk";
  const guest = scene.startsWith("login") || scene === "mine-guest" || scene === "agreement";
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    let data: unknown;
    if (path === "/m/bootstrap") data = bootstrap;
    else if (path === "/m/sessions")
      data = guest
        ? { needPhone: true, token: null, me: null }
        : {
            needPhone: false,
            token: "lyxm_offline",
            me: makeMe(clerk, scene === "reconsent" && !accepted),
          };
    else if (path.startsWith("/m/agreements?")) data = agreements;
    else if (path.startsWith("/m/agreement-versions/")) data = agreement;
    else if (path === "/m/me") data = makeMe(clerk, scene === "reconsent" && !accepted);
    else if (path === "/m/me/overview") data = makeOverview(clerk, second);
    else if (path === "/m/stores") data = makeStores(clerk);
    else if (path === "/m/agreement-consents") {
      accepted = true;
      data = { pendingConsents: [], consents: [] };
    } else if (path === "/m/me/current-store") {
      second = (options?.data as { storeId?: string })?.storeId === ID2;
      data = { storeId: second ? ID2 : ID };
    } else if (path === "/m/sessions/current") data = null;
    else if (path === "/m/sessions/phone-login")
      data = { token: "lyxm_offline", me: makeMe(), isNewUser: false, switchedFrom: null };
    else throw new Error(`离线场景未登记调用：${path}`);
    return data as T;
  };
}
