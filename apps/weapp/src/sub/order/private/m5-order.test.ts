import { describe, expect, it, vi } from "vitest";
import { orderAd, quoteWithAd } from "../../../../shots/order-m5-fixtures";
import { actualAdUrl, reconcileOrderAds, selectableOrderAd } from "./m5-order";
import { createOrderIntent, quoteRefreshMessage } from "@/stores/order";
import { ApiError, type RequestLayer, type RequestOptions } from "@/lib/request";
import { WEAPP_PAGES } from "@/pages";
vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
import { createOrderApi } from "./api";
describe("确认订购广告事实", () => {
  it("只有本次fresh报价包含的可选确认版可选，换版/取消/位置不支持均清旧选择", () => {
    const selection = [{ adId: orderAd.adId, confirmedVersionNo: 2 }];
    expect(reconcileOrderAds(quoteWithAd, [orderAd], selection)).toEqual(selection);
    for (const ad of [
      { ...orderAd, isSelectable: false },
      { ...orderAd, hasOpenCancelRequest: true },
      { ...orderAd, confirmedVersionNo: 3 },
      { ...orderAd, status: "cancelled" },
    ])
      expect(reconcileOrderAds(quoteWithAd, [ad], selection)).toEqual([]);
    expect(reconcileOrderAds({ ...quoteWithAd, ads: [] }, [orderAd], selection)).toEqual([]);
    expect(
      selectableOrderAd(
        {
          ...quoteWithAd,
          items: quoteWithAd.items.map((item) => ({ ...item, allowedPlacements: ["ending"] })),
        },
        orderAd,
      ),
    ).toBe(false);
    expect(reconcileOrderAds(quoteWithAd, [orderAd], [...selection, ...selection])).toHaveLength(1);
    expect(selectableOrderAd(quoteWithAd, { ...orderAd, status: "revising" })).toBe(true);
    const detailPage = WEAPP_PAGES.find((page) => page.route === "sub/ad/ad-detail/index")!;
    const implemented = detailPage.implemented;
    try {
      detailPage.implemented = false;
      expect(actualAdUrl(orderAd.adId)).toBeNull();
    } finally {
      detailPage.implemented = implemented;
    }
  });
  it("真实登记已实现的广告详情入口携带广告id并编码查询值", () => {
    expect(WEAPP_PAGES.find((page) => page.route === "sub/ad/ad-detail/index")?.implemented).toBe(
      true,
    );
    expect(actualAdUrl(orderAd.adId)).toBe(`/sub/ad/ad-detail/index?adId=${orderAd.adId}`);
    expect(actualAdUrl("ad/?&=#+")).toBe("/sub/ad/ad-detail/index?adId=ad%2F%3F%26%3D%23%2B");
  });
  it("重报价只发真实三字段，create发实际adIds，未知结果同key，广告失效走刷新错误符号", async () => {
    const send = vi.fn(async (_path: string, _options?: RequestOptions): Promise<unknown> => null);
    const request: RequestLayer["request"] = async <T>(
      path: string,
      options?: RequestOptions,
    ): Promise<T> => (await send(path, options)) as T;
    const api = createOrderApi(request);
    const quote = {
      dramaIds: [quoteWithAd.items[0]!.drama.dramaId],
      channelAccountIds: [quoteWithAd.channelAccounts[0]!.channelAccountId],
      isTopModel: false,
    };
    await api.quote(quote);
    expect(send.mock.calls[0]).toEqual(["/m/orders/quote", { method: "POST", data: quote }]);
    let n = 0;
    const intent = createOrderIntent(() => `order-${++n}`);
    const body = {
      ...quote,
      focusCodes: ["product"],
      agreementVersionId: quoteWithAd.agreement.agreementVersionId,
      expect: quoteWithAd.expect,
      adIds: [orderAd.adId],
    };
    await api.create(body, intent.current());
    await api.create(body, intent.current());
    expect(send.mock.calls[1]).toEqual(send.mock.calls[2]);
    intent.changed();
    expect(intent.current()).toBe("order-2");
    expect(
      quoteRefreshMessage(
        new ApiError({
          error: "ORDER_AD_INVALID",
          status: 409,
          requestId: "fixture",
          message: "not a switch",
        }),
      ),
    ).toContain("重新选择");
  });
});
