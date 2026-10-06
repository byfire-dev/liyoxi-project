import type { components } from "@liyoxi/contract/types/merchant";
import type { Data, Body } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import { orderAccount } from "./order-fixtures";
export const publishScreenshot = {
  fileId: "00000000-0000-4000-8000-000000000701",
  src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='200'%3E%3Crect width='150' height='200' fill='white'/%3E%3Ctext x='10' y='40'%3Ecoffee-life%3C/text%3E%3C/svg%3E",
};
export const rejectedAccount: components["schemas"]["ChannelAccountCard"] = {
  ...orderAccount,
  channelAccountId: "00000000-0000-4000-8000-000000000502",
  platform: "wechat_channels",
  accountName: "邻里咖啡视频号",
  accountUid: "coffee-channel",
  status: "abnormal",
  accountType: null,
  submittedAccountType: "enterprise",
  verifiedAt: null,
  abnormalSource: "verify",
  abnormalReason: { code: "screenshot_incomplete", name: "主页截图不完整" },
  abnormalNote: "请补充账号 ID 和认证信息",
  actions: ["submit"],
};
export function offlinePublishRequest(scene: string): RequestLayer["request"] {
  const calls: { path: string; method: string; key?: string; data?: unknown }[] = [];
  (globalThis as { __LYX_PUBLISH_CALLS__?: typeof calls }).__LYX_PUBLISH_CALLS__ = calls;
  let creates = 0;
  let submitted: components["schemas"]["ChannelAccountCard"] | null = null;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const method = options?.method ?? "GET";
    calls.push({
      path,
      method,
      ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
      ...(options?.data ? { data: options.data } : {}),
    });
    let data: unknown;
    if (method === "GET" && path.startsWith("/m/channel-accounts"))
      data = {
        items: submitted
          ? [orderAccount, submitted]
          : scene === "accounts-rejected"
            ? [orderAccount, rejectedAccount]
            : [orderAccount],
        hasMore: false,
        nextCursor: null,
      } satisfies Data<"m.channelAccount.list">;
    else if (method === "POST" && path === "/m/channel-accounts") {
      if (!options?.idempotencyKey) throw new Error("绑定必须携带幂等键");
      creates++;
      if (creates === 1 && scene === "accounts-bind")
        throw new ApiError({
          error: "NETWORK_ERROR",
          message: "网络暂时中断，请重试",
          status: 0,
          requestId: "publish-offline",
        });
      const body = options.data as Body<"m.channelAccount.create">;
      submitted = {
        ...orderAccount,
        channelAccountId: rejectedAccount.channelAccountId,
        platform: body.platform,
        accountName: body.accountName,
        accountUid: body.accountUid,
        status: "pending_verify",
        accountType: null,
        submittedAccountType: body.accountType,
        verifiedAt: null,
        actions: [],
      };
      data = submitted satisfies Data<"m.channelAccount.create">;
    } else if (method === "POST" && path.endsWith("/submit")) {
      if (!options?.idempotencyKey) throw new Error("重提必须携带幂等键");
      submitted = {
        ...rejectedAccount,
        status: "pending_verify",
        abnormalSource: null,
        abnormalReason: null,
        abnormalNote: null,
        actions: [],
      };
      data = submitted satisfies Data<"m.channelAccount.submit">;
    } else
      throw new ApiError({
        error: "NOT_FOUND",
        message: "无此离线账号夹具",
        status: 404,
        requestId: "publish-offline",
      });
    return structuredClone(data) as T;
  };
}
