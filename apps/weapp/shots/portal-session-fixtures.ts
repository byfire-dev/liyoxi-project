import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import { makeMe } from "./account-fixtures";

/** Contract-backed presentation fixture; it is not evidence of backend revocation. */
export function offlinePortalSessionRequest(scene: string): RequestLayer["request"] {
  const now = Date.now();
  let items: Data<"m.portalSession.list">["items"] =
    scene === "settings-portals-empty"
      ? []
      : makeMe().memberships[0]!.stores.map((store, index) => ({
          portalSessionId: `019a4500-0000-7000-8000-00000000030${index}`,
          storeId: store.storeId,
          storeName: store.name,
          grantScope: "store" as const,
          browser: index === 0 ? "Chrome · macOS" : "Edge · Windows",
          regionHint: index === 0 ? "深圳" : null,
          authorizedAt: new Date(now - 30 * 60_000).toISOString(),
          expiresAt: new Date(now + 90 * 60_000).toISOString(),
          revokedAt: null,
        }));
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const method = options?.method ?? "GET";
    if (path === "/m/portal-sessions" && method === "GET") {
      if (scene === "settings-portals-error")
        throw new ApiError({
          error: "HTTP_503",
          message: "电脑授权列表暂时不可用",
          status: 503,
          requestId: "shot",
        });
      return { items: items.map((item) => ({ ...item })) } as T;
    }
    const item = items.find(
      (entry) => path === `/m/portal-sessions/${entry.portalSessionId}/revoke`,
    );
    if (!item || method !== "POST" || !options?.idempotencyKey || options.data !== undefined)
      throw new Error("电脑管理样张出现未登记或缺幂等键的调用");
    const receipt: Data<"m.portalSession.revoke"> = {
      ...item,
      revokedAt: new Date(now).toISOString(),
    };
    items = items.filter((entry) => entry.portalSessionId !== item.portalSessionId);
    return receipt as T;
  };
}
