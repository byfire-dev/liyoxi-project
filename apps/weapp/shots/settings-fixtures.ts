import type { Data, Me } from "../src/sub/service/settings/api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import { makeMe, agreements } from "./account-fixtures";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-13T04:00:00Z";
export function offlineSettingsRequest(scene: string): RequestLayer["request"] {
  let me: Me = makeMe(scene === "settings-clerk");
  if (scene === "settings-notice-retry")
    me.notices = [
      {
        userNoticeId: id(50),
        kind: "new_wechat_bound",
        occurredAt: now,
        message: "账号刚在另一台设备登录，请确认是否本人操作。",
      },
    ];
  let failedNotice = false;
  const calls: { path: string; method: string; key?: string }[] = [];
  (globalThis as { __LYX_SETTINGS_CALLS__?: typeof calls }).__LYX_SETTINGS_CALLS__ = calls;
  if (scene === "settings-phone-unavailable") me.user.actions = ["update", "deletion"];
  const identities: Data<"m.me.wechatIdentity.list"> = {
    items: [0, 1].map((n) => ({
      wechatIdentityId: id(n + 20),
      boundAt: now,
      lastLoginAt: now,
      deviceSummary: n ? "另一台手机" : "此设备",
      isCurrent: n === 0,
      actions: ["delete"],
    })),
    nextCursor: null,
    hasMore: false,
  };
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const method = options?.method ?? "GET";
    calls.push({ path, method, key: options?.idempotencyKey });
    let value: unknown;
    if (path === "/m/me" && method === "GET") value = me;
    else if (path.startsWith("/m/agreements?")) value = agreements;
    else if (path === "/m/me" && method === "PATCH") {
      const body = options?.data as { displayName: string };
      me = { ...me, user: { ...me.user, displayName: body.displayName } };
      value = me.user;
    } else if (path.startsWith("/m/me/wechat-identities?") && method === "GET") value = identities;
    else if (path.startsWith("/m/me/wechat-identities/") && method === "DELETE") {
      const identity = identities.items.find((item) => path.endsWith(item.wechatIdentityId));
      identities.items = identities.items.filter((item) => item !== identity);
      value = {
        wechatIdentityId: identity?.wechatIdentityId ?? id(20),
        revokedSessionCount: 1,
        isCurrentSessionRevoked: identity?.isCurrent ?? false,
      } satisfies Data<"m.me.wechatIdentity.delete">;
    } else if (path === "/m/sms-codes")
      throw new ApiError({
        error: "SMS_UNAVAILABLE",
        message: "短信验证暂不可用",
        status: 503,
        requestId: "shot",
      });
    else if (path === "/m/me/deletion")
      throw new ApiError({
        error: "ACCOUNT_DELETION_BLOCKED",
        message: "主体还有未办结事项",
        status: 409,
        requestId: "shot",
        details: {
          blockers: [
            "subscription_active",
            "payment_open",
            "refund_open",
            "invoice_open",
            "open_order",
            "release_online",
          ].map((kind) => ({ kind, count: 1 })),
        },
      });
    else if (path.includes("/user-notices/")) {
      if (scene === "settings-notice-retry" && !failedNotice) {
        failedNotice = true;
        throw new ApiError({
          error: "NETWORK_ERROR",
          message: "网络暂不可用",
          status: 0,
          requestId: "shot",
        });
      }
      const userNoticeId = path.split("/").at(-2)!;
      me = { ...me, notices: me.notices.filter((item) => item.userNoticeId !== userNoticeId) };
      value = { userNoticeId, ackedAt: now } satisfies Data<"m.me.userNotice.acknowledge">;
    } else throw new Error("设置样张未登记此调用");
    return value as T;
  };
}
