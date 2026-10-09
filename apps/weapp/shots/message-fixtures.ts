import type { Body, Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError, createRequestLayer } from "../src/lib/request";
import { useContextStore } from "../src/stores/context";
import { useSessionStore } from "../src/stores/session";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const categories = [
  "order",
  "delivery",
  "launch",
  "plan_points",
  "review",
  "store",
  "service",
] as const;
const titles = [
  "订单开始制作",
  "交付进度更新",
  "发布任务已安排",
  "积分变动通知",
  "门店审核通过",
  "门店资料已更新",
  "账号安全提醒",
];
type Message = Data<"m.message.list">["items"][number];
export function offlineMessageRequest(scene: string): RequestLayer["request"] {
  const clerk = scene === "messages-clerk",
    noStore = scene === "messages-no-store";
  let items: Message[] =
    scene === "messages-empty"
      ? []
      : Array.from({ length: scene === "messages-more" ? 24 : 7 }, (_, n): Message => ({
          messageId: ID(n + 10),
          category: categories[n % 7] ?? "service",
          title: titles[n % 7] ?? "门店消息",
          body:
            n % 7 === 3
              ? "本次积分变动 +120，可用余额以钱包为准。"
              : noStore
                ? "这是你的账号安全通知，与门店无关。"
                : "消息内容来自服务端。请查看当前门店的相关进展。",
          ctaText: "查看详情",
          link:
            scene === "messages-unavailable"
              ? { route: "ticket.detail", params: { serviceTicketId: ID(2), storeId: ID(1) } }
              : { route: "messages.list", params: {} },
          storeId: noStore ? null : ID(1),
          isRead: n > 3,
          readAt: n > 3 ? "2026-10-08T00:00:00Z" : null,
          createdAt: `2026-10-0${n > 3 ? 7 : 8}T00:00:00Z`,
          createdDate: n > 3 ? "2026-10-07" : "2026-10-08",
        }));
  if (clerk) items = items.filter((item) => item.category !== "plan_points");
  if (noStore)
    items = items
      .slice(0, 1)
      .map((item) => ({ ...item, category: "service", title: "账号安全提醒" }));
  const calls: { path: string; method: string; key?: string; data?: unknown }[] = [];
  (globalThis as { __LYX_MESSAGE_CALLS__?: typeof calls }).__LYX_MESSAGE_CALLS__ = calls;
  const results = new Map<string, unknown>();
  let failed = false;
  const summary = (): Data<"m.message.summary"> => {
    const unread = items.filter((item) => !item.isRead);
    return {
      total: unread.length,
      byTab: (["all", ...categories] as const).map((tab) => ({
        tab,
        unreadCount: unread.filter((item) => tab === "all" || item.category === tab).length,
      })),
      byStore: noStore ? [] : [{ storeId: ID(1), unreadCount: unread.length }],
    };
  };
  const handle: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ): Promise<T> => {
    const url = new URL(path, "http://local"),
      method = options?.method ?? "GET";
    calls.push({ path, method, key: options?.idempotencyKey, data: options?.data });
    if (options?.idempotencyKey && results.has(options.idempotencyKey))
      return results.get(options.idempotencyKey) as T;
    let data: unknown;
    if (url.pathname === "/m/messages/summary") data = summary();
    else if (url.pathname === "/m/messages" && method === "GET") {
      if (scene === "messages-loading") return new Promise<T>(() => {});
      if (scene === "messages-error") throw new Error("消息暂时加载失败，请重试");
      const tab = url.searchParams.get("tab"),
        filtered = items.filter((item) => tab === "all" || item.category === tab);
      const cursor = url.searchParams.get("cursor"),
        offset = cursor === "opaque+/=page2" ? 20 : 0;
      data = {
        items: filtered.slice(offset, offset + 20),
        nextCursor: filtered.length > offset + 20 ? "opaque+/=page2" : null,
        hasMore: filtered.length > offset + 20,
      };
    } else if (url.pathname === "/m/messages/read") {
      if (scene === "messages-all-read" && !failed) {
        failed = true;
        throw new Error("网络暂时中断，请重试");
      }
      const body = options?.data as Body<"m.message.batchRead">;
      const boundary = items.findIndex((item) => item.messageId === body.upToMessageId);
      let markedCount = 0;
      items = items.map((item, n) => {
        if (n >= boundary && (body.tab === "all" || item.category === body.tab) && !item.isRead) {
          markedCount++;
          return { ...item, isRead: true, readAt: "2026-10-08T01:00:00Z" };
        }
        return item;
      });
      data = { markedCount, summary: summary() };
    } else if (/^\/m\/messages\/[^/]+\/read$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const item = items.find((row) => row.messageId === id);
      if (!item)
        throw new ApiError({
          error: "HTTP_404",
          status: 404,
          message: "消息已不可访问",
          requestId: "fictional",
        });
      const readAt = item.readAt ?? "2026-10-08T01:00:00Z";
      items = items.map((row) => (row.messageId === id ? { ...row, isRead: true, readAt } : row));
      data = { messageId: id, readAt };
    } else if (url.pathname === "/m/notify-settings")
      data = {
        items: [
          {
            slotKey: "order_progress",
            title: "订单进度",
            sceneNames: ["订单开始制作"],
            tmplId: null,
            state: "unavailable",
            estRemaining: 0,
            lastAcceptAt: null,
          },
          {
            slotKey: "review_result",
            title: "审核结果",
            sceneNames: ["门店审核结果"],
            tmplId: null,
            state: "rejected",
            estRemaining: 0,
            lastAcceptAt: null,
          },
        ],
        cooldownDays: 7,
        maxPerAsk: 3,
      } satisfies Data<"m.notifySetting.list">;
    else throw new Error(`消息离线场景未登记调用：${path}`);
    if (options?.idempotencyKey) results.set(options.idempotencyKey, data);
    return data as T;
  };
  const headers: { path: string; storeId: string | undefined }[] = [];
  (globalThis as { __LYX_MESSAGE_HEADERS__?: typeof headers }).__LYX_MESSAGE_HEADERS__ = headers;
  return createRequestLayer({
    baseUrl: "https://fictional.message.test",
    getToken: () => useSessionStore.getState().accessToken,
    getStoreId: () => useContextStore.getState().currentStoreId,
    clock: { now: () => 0, sleep: async () => {} },
    uuid: () => ID(900),
    client: () => ({ platform: "ios", version: "0.1.0", envVersion: "trial" }),
    send: async (request) => {
      const url = new URL(request.url),
        path = url.pathname.replace(/^\/api\/v1/, "") + url.search;
      headers.push({ path, storeId: request.header["X-Store-Id"] });
      return {
        statusCode: 200,
        header: {},
        data: {
          code: 0,
          message: "ok",
          data: await handle(path, {
            method: request.method,
            data: request.data,
            idempotencyKey: request.header["Idempotency-Key"],
          }),
        },
      };
    },
  }).request;
}
