import { expect, it, vi } from "vitest";
import { createPortalClient } from "../../lib/api";
import { ok } from "../../lib/api.test-helpers";
import { createItemsApi } from "./api";
import { createItemApi } from "../item/api";

it("正式列表使用limit与不透明cursor，广告筛选与订购项互不混用", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => ok({ items: [], nextCursor: null, hasMore: false }));
  const client = createPortalClient({ fetch: send });
  const api = createItemsApi(client);
  const signal = new AbortController().signal;
  await api.orders("opaque+/cursor=", signal);
  await api.ads("other-cursor", signal);
  const orders = new URL(String(send.mock.calls[0]![0]), "https://portal.example.invalid");
  expect(orders.pathname).toBe("/api/v1/portal/order-items");
  expect(Object.fromEntries(orders.searchParams)).toEqual({
    tab: "all",
    limit: "20",
    cursor: "opaque+/cursor=",
  });
  const ads = new URL(String(send.mock.calls[1]![0]), "https://portal.example.invalid");
  expect(Object.fromEntries(ads.searchParams)).toEqual({
    status: "pending_confirm",
    limit: "20",
    cursor: "other-cursor",
  });
  expect(
    send.mock.calls.every(
      ([, init]) => init?.credentials === "same-origin" && init.cache === "no-store",
    ),
  ).toBe(true);
  client.dispose();
});

it("所有下载现签POST，文本查询独立GET且不携带客户端门店", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => ok({}));
  const client = createPortalClient({ fetch: send });
  const api = createItemApi(client);
  const signal = new AbortController().signal;
  for (const body of [
    { kind: "episode" as const, episodeNo: 2 },
    { kind: "zip" as const, retry: true },
    { kind: "publish_list" as const },
  ])
    await api.download("item-id", body, signal);
  await api.publishList("item-id", signal);
  expect(
    send.mock.calls
      .slice(0, 3)
      .map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))]),
  ).toEqual([
    ["/api/v1/portal/order-items/item-id/download-urls", "POST", { kind: "episode", episodeNo: 2 }],
    ["/api/v1/portal/order-items/item-id/download-urls", "POST", { kind: "zip", retry: true }],
    ["/api/v1/portal/order-items/item-id/download-urls", "POST", { kind: "publish_list" }],
  ]);
  expect(send.mock.calls[3]![0]).toBe("/api/v1/portal/order-items/item-id/publish-list");
  expect(send.mock.calls[3]![1]?.method).toBe("GET");
  client.dispose();
});
