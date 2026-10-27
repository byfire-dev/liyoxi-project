import { AdminPaymentOrderListQuerySchema } from "@liyoxi/contract";
import { dateValue, keyword, pageNumber, pageSize } from "../../billing/accounts/model";
import { idValue } from "../../billing/plans/model";
export const paymentTabs = [
  "all",
  "pending_payment",
  "pending_confirmation",
  "paid",
  "cancelled",
  "refunded",
] as const;
export const paymentStatus: Record<string, string> = {
  all: "全部",
  pending_payment: "待付款",
  pending_confirmation: "待确认",
  paid: "已付款",
  cancelled: "已取消",
  refunded: "已退款",
};
export const paymentTypes: Record<string, string> = {
  plan_new: "开通套餐",
  plan_renew: "续费套餐",
  plan_upgrade: "套餐升级",
  topup: "积分包",
};
export function paymentSearch(raw: Record<string, unknown>) {
  return {
    view: raw.view === "payments" ? ("payments" as const) : ("drama" as const),
    payPage: pageNumber(raw.payPage),
    paySize: pageSize(raw.paySize),
    payQ: keyword(raw.payQ),
    payNo: keyword(raw.payNo),
    payEntityId: idValue(raw.payEntityId),
    payStoreId: idValue(raw.payStoreId),
    payType:
      typeof raw.payType === "string" &&
      AdminPaymentOrderListQuerySchema.shape.type.safeParse(raw.payType).success
        ? raw.payType
        : undefined,
    payChannel:
      raw.payChannel === "bank_transfer"
        ? ("bank_transfer" as const)
        : raw.payChannel === "wechat_jsapi"
          ? ("wechat_jsapi" as const)
          : undefined,
    paySource:
      raw.paySource === "admin"
        ? ("admin" as const)
        : raw.paySource === "weapp"
          ? ("weapp" as const)
          : undefined,
    payException:
      raw.payException === "true"
        ? ("true" as const)
        : raw.payException === "false"
          ? ("false" as const)
          : undefined,
    payFrom: dateValue(raw.payFrom),
    payTo: dateValue(raw.payTo),
    paySort: raw.paySort === "-amountFen" ? ("-amountFen" as const) : ("-createdAt" as const),
    payTab: paymentTabs.find((t) => t === raw.payTab) ?? "all",
    paymentId: idValue(raw.paymentId),
  };
}
export function paymentFilters(s: ReturnType<typeof paymentSearch>) {
  return {
    q: s.payQ,
    no: s.payNo,
    entityId: s.payEntityId,
    storeId: s.payStoreId,
    type: s.payType,
    channel: s.payChannel,
    source: s.paySource,
    hasOpenException: s.payException,
    createdFrom: s.payFrom,
    createdTo: s.payTo,
    sort: s.paySort,
  };
}
export function paymentQuery(s: ReturnType<typeof paymentSearch>) {
  return { ...paymentFilters(s), tab: s.payTab, page: s.payPage, pageSize: s.paySize };
}
