import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { makeMe } from "./account-fixtures";

/** H5 contract screenshots only: no real ticket, session, scan or authorization is created. */
export function offlinePortalApprovalRequest(scene: string): RequestLayer["request"] {
  const now = Date.now();
  const store = makeMe().memberships[0]!.stores[0]!;
  const preview: Data<"m.portalTicket.lookup"> = {
    portalTicketId: "019a4500-0000-7000-8000-000000000201",
    browser: "Chrome · macOS",
    regionHint: "深圳",
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + (scene === "portal-approve-expired" ? -1_000 : 60_000)).toISOString(),
    pairChoices: ["17", "42", "83"],
    storeId: store.storeId,
    storeName: store.name,
  };
  const calls: { path: string; method: string; key?: string; body?: unknown }[] = [];
  (globalThis as { __LYX_PORTAL_APPROVAL_CALLS__?: typeof calls }).__LYX_PORTAL_APPROVAL_CALLS__ =
    calls;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    const method = options?.method ?? "GET";
    calls.push({ path, method, key: options?.idempotencyKey, body: options?.data });
    if (path === "/m/portal-tickets/lookup?code=12ABCDEF" && method === "GET")
      return { ...preview, pairChoices: [...preview.pairChoices] } as T;
    const base = `/m/portal-tickets/${preview.portalTicketId}`;
    if (method !== "POST" || !options?.idempotencyKey || scene === "portal-approve-expired")
      throw new Error("电脑授权样张出现未登记或缺幂等键的调用");
    let value: Data<"m.portalTicket.approve">;
    if (path === `${base}/approve`) {
      const pair = (options.data as { pairDigits?: unknown } | undefined)?.pairDigits;
      if (typeof pair !== "string" || !preview.pairChoices.includes(pair))
        throw new Error("电脑授权样张的配对数字未登记");
      const approved = pair === "17";
      value = {
        portalTicketId: preview.portalTicketId,
        status: approved ? "approved" : "rejected",
        rejectReason: approved ? null : "pair_mismatch",
        approvedAt: approved ? new Date(now).toISOString() : null,
        storeId: approved ? preview.storeId : null,
      };
    } else if (path === `${base}/reject` && options.data === undefined) {
      value = {
        portalTicketId: preview.portalTicketId,
        status: "rejected",
        rejectReason: "by_owner",
        approvedAt: null,
        storeId: null,
      };
    } else throw new Error("电脑授权样张未登记此调用");
    return value as T;
  };
}
