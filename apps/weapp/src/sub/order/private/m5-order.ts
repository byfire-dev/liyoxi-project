import type { Data } from "@/lib/account-api";
import { WEAPP_PAGES } from "@/pages";
import type { OrderQuote } from "@/stores/order";
export type OrderAd = Data<"m.ad.list">["items"][number];
export type SelectedOrderAd = Pick<OrderQuote["ads"][number], "adId" | "confirmedVersionNo">;
export function selectableOrderAd(quote: OrderQuote, ad: OrderAd): boolean {
  const candidate = quote.ads.find((item) => item.adId === ad.adId);
  return Boolean(
    candidate &&
    ad.isSelectable &&
    !ad.hasOpenCancelRequest &&
    ad.status !== "cancelled" &&
    ad.confirmedVersionNo === candidate.confirmedVersionNo &&
    quote.items.every((item) => item.allowedPlacements.includes(candidate.type)),
  );
}
export function reconcileOrderAds(
  quote: OrderQuote,
  ads: readonly OrderAd[],
  selected: readonly SelectedOrderAd[],
): SelectedOrderAd[] {
  const slots = new Set<string>();
  return selected.filter((value) => {
    const ad = ads.find((item) => item.adId === value.adId);
    if (
      !ad ||
      !selectableOrderAd(quote, ad) ||
      ad.confirmedVersionNo !== value.confirmedVersionNo ||
      slots.has(ad.type)
    )
      return false;
    slots.add(ad.type);
    return true;
  });
}
export function actualAdUrl(adId: string): string | null {
  return WEAPP_PAGES.some((page) => page.route === "sub/ad/ad-detail/index" && page.implemented)
    ? `/sub/ad/ad-detail/index?adId=${encodeURIComponent(adId)}`
    : null;
}
