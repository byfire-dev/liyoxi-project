import type { PortalSession } from "../features/session/api";

export const SESSION: PortalSession = {
  portalSessionId: "019a4500-0000-7000-8000-000000000001",
  entityId: "019a4500-0000-7000-8000-000000000002",
  storeId: "019a4500-0000-7000-8000-000000000003",
  storeName: "测试门店",
  entityName: "测试主体",
  authorizerPhoneMask: "138****0000",
  isStoreArchived: false,
  grantScope: "store",
  capabilities: ["ad.view", "episode.download"],
  authorizedAt: "2026-11-04T00:00:00.000Z",
  expiresAt: "2026-11-04T02:00:00.000Z",
  serverTime: "2026-11-04T00:00:00.000Z",
};
export const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export const failure = (
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: HeadersInit = {},
) =>
  new Response(
    JSON.stringify({
      code: status * 100,
      error,
      message: "不信任的服务端原文",
      retryable: false,
      requestId: "019a4500-0000-7000-8000-000000000004",
      ...extra,
    }),
    { status, headers },
  );
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
