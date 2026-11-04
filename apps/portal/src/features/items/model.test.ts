import { expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { deferred, ok, SESSION } from "../../lib/api.test-helpers";
import type { AdPage, ItemsApi, OrderPage } from "./api";
import { createItemsModel } from "./model";
import { PortalApiError } from "../../lib/api-errors";

const empty = { items: [], hasMore: false, nextCursor: null };
async function harness() {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => ok(SESSION));
  const runtime = createPortalRuntime({ fetch: send });
  await runtime.session.load();
  const api: ItemsApi = {
    orders: vi.fn().mockResolvedValue(empty),
    ads: vi.fn().mockResolvedValue(empty),
  };
  return { runtime, send, api, model: createItemsModel(api, runtime.session) };
}
it("订购与广告各自游标/失败/空态，广告失败不抹掉成片", async () => {
  const h = await harness();
  vi.mocked(h.api.orders).mockResolvedValueOnce({
    ...empty,
    hasMore: true,
    nextCursor: "orders-next",
  });
  vi.mocked(h.api.ads).mockResolvedValueOnce({ ...empty, hasMore: true, nextCursor: "ads-next" });
  await Promise.all([h.model.load("orders"), h.model.load("ads")]);
  vi.mocked(h.api.ads).mockRejectedValueOnce(new PortalApiError("NOT_FOUND", 404));
  await h.model.load("ads", true);
  await h.model.load("orders", true);
  expect(h.api.ads).toHaveBeenLastCalledWith("ads-next", expect.any(AbortSignal));
  expect(h.api.orders).toHaveBeenLastCalledWith("orders-next", expect.any(AbortSignal));
  expect(h.model.getSnapshot().ads.error).not.toBe("");
  expect(h.model.getSnapshot().orders).toEqual({ page: empty, loading: false, error: "" });
  h.model.stop();
  h.runtime.dispose();
});
it("换门店或卸载后旧列表的迟到结果不回写", async () => {
  const h = await harness();
  const pending = deferred<OrderPage>();
  vi.mocked(h.api.orders).mockReturnValueOnce(pending.promise);
  const loading = h.model.load("orders");
  h.send.mockImplementation(async () =>
    ok({ ...SESSION, storeId: "019a4500-0000-7000-8000-000000000099" }),
  );
  await h.runtime.session.load();
  pending.resolve({ ...empty, nextCursor: "old-store" });
  await loading;
  expect(h.model.getSnapshot().orders.page).toBeNull();
  expect(vi.mocked(h.api.orders).mock.calls[0]![1].aborted).toBe(true);
  const ads = deferred<AdPage>();
  vi.mocked(h.api.ads).mockReturnValueOnce(ads.promise);
  const request = h.model.load("ads");
  h.model.stop();
  ads.resolve(empty);
  await request;
  expect(h.model.getSnapshot().ads.page).toBeNull();
  h.runtime.dispose();
});
