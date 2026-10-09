import { WEAPP_PAGES } from "@/pages";
import type { Message } from "./api";

export type MessageTarget =
  { url: string; tab?: boolean } | { notice: string } | { agreementKey: string };
export function messageTarget(
  link: Message["link"],
  context: { storeId: string | null; owner: boolean },
): MessageTarget {
  if ("storeId" in link.params && link.params.storeId !== context.storeId)
    return { notice: "请先切换到对应门店，再打开消息" };
  if (link.route === "agreement.view") return { agreementKey: link.params.key };
  if (link.route === "messages.list") return { notice: "消息详情已在当前列表中展示" };
  let route = "",
    params: Record<string, string> = {},
    tab = false,
    ownerOnly = false;
  switch (link.route) {
    case "order.detail":
      route = "sub/order/order-detail/index";
      params = { orderId: link.params.orderId };
      ownerOnly = true;
      break;
    case "delivery.sample":
      route = "sub/order/sample/index";
      params = { orderItemId: link.params.orderItemId };
      ownerOnly = true;
      break;
    case "delivery.plan":
      route = "sub/order/plan/index";
      params = { deliveryPlanId: link.params.deliveryPlanId };
      ownerOnly = true;
      break;
    case "publish.task":
      route = "sub/publish/tasks/index";
      params = {
        launchTaskId: link.params.launchTaskId,
        ...(link.params.date ? { date: link.params.date } : {}),
      };
      ownerOnly = true;
      break;
    case "payment.result":
    case "payment.detail":
      route = "sub/order/result/index";
      params = { type: "payment", paymentOrderId: link.params.paymentOrderId };
      ownerOnly = true;
      break;
    case "wallet.home":
      route = "sub/billing/wallet/index";
      ownerOnly = true;
      break;
    case "cart.list":
      route = "pages/cart/index";
      tab = true;
      ownerOnly = true;
      break;
    case "profile.review":
      route = "sub/profile/review/index";
      ownerOnly = true;
      break;
  }
  if (!route || !WEAPP_PAGES.some((page) => page.route === route && page.implemented))
    return { notice: "该内容暂不可访问，消息仍会保留" };
  if (ownerOnly && !context.owner) return { notice: "当前角色不可访问该内容" };
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return { url: `/${route}${query ? `?${query}` : ""}`, tab };
}
