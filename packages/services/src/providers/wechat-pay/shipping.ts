// 官方小程序发货API（access_token），不是商户V3接口：
// https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo
// https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_getorder
import { failed, ok } from "../types.js";
import type {
  ProviderResult,
  WechatShippingInput,
  WechatShippingOrder,
  WechatShippingFailure,
} from "../types.js";
import type { WechatHttpFailure } from "../wechat/client.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function shippingBody(input: WechatShippingInput): Record<string, unknown> | null {
  if (
    !text(input.transactionId) ||
    input.transactionId.length > 128 ||
    !text(input.payerOpenid) ||
    input.payerOpenid.length > 128 ||
    !text(input.itemDescription) ||
    [...input.itemDescription].length > 120 ||
    !(input.uploadedAt instanceof Date) ||
    !Number.isFinite(input.uploadedAt.getTime())
  )
    return null;
  const uploadTime = input.uploadedAt.toISOString();
  if (!/^\d{4}-/.test(uploadTime)) return null;
  return {
    order_key: { order_number_type: 2, transaction_id: input.transactionId },
    logistics_type: 3,
    delivery_mode: 1,
    shipping_list: [{ item_desc: input.itemDescription }],
    upload_time: uploadTime,
    payer: { openid: input.payerOpenid },
  };
}
export function shippingFailure(
  acceptance: "not_accepted" | "unknown",
  rejected = false,
): WechatShippingFailure {
  return { ...failed(rejected ? "rejected" : "unavailable", "微信发货请求未确认完成"), acceptance };
}
/** 只有完整2xx的已知平台拒绝能证明未受理；系统错误/HTTP未知保持unknown。 */
export function shippingHttpFailure(failure: WechatHttpFailure): WechatShippingFailure {
  const rejected =
    failure.status !== undefined &&
    failure.status >= 200 &&
    failure.status < 300 &&
    failure.code !== undefined &&
    [
      40001, 40014, 42001, 10060001, 10060002, 10060003, 10060004, 10060005, 10060006, 10060007,
      10060008, 10060009, 10060014, 10060020, 10060023, 10060024, 10060025, 10060026, 10060031,
      268485194, 268485195, 268485196, 268485197, 268485216, 268485224, 268485226, 268485227,
      268485228,
    ].includes(failure.code);
  return shippingFailure(
    rejected ? "not_accepted" : "unknown",
    rejected && ![40001, 40014, 42001].includes(failure.code!),
  );
}
export function shippingUploadResult(value: unknown) {
  return object(value) && value["errcode"] === 0 ? ok(undefined) : shippingFailure("unknown");
}
export function shippingOrderResult(value: unknown): ProviderResult<WechatShippingOrder> {
  const invalid = () => failed("unavailable", "微信发货查单缺少完整事实");
  if (!object(value) || value["errcode"] !== 0 || !object(value["order"])) return invalid();
  const order = value["order"];
  if (
    !text(order["transaction_id"]) ||
    !text(order["merchant_trade_no"]) ||
    !text(order["merchant_id"]) ||
    !text(order["openid"]) ||
    !integer(order["paid_amount"]) ||
    !integer(order["order_state"]) ||
    order["order_state"] < 1 ||
    order["order_state"] > 6
  )
    return invalid();
  let shipping: WechatShippingOrder["shipping"] = null;
  if (order["shipping"] !== undefined && order["shipping"] !== null) {
    const raw = order["shipping"];
    if (
      !object(raw) ||
      !integer(raw["logistics_type"]) ||
      !integer(raw["delivery_mode"]) ||
      typeof raw["finish_shipping"] !== "boolean" ||
      !Array.isArray(raw["shipping_list"])
    )
      return invalid();
    const items: NonNullable<WechatShippingOrder["shipping"]>["items"] = [];
    for (const item of raw["shipping_list"]) {
      if (
        !object(item) ||
        !integer(item["upload_time"]) ||
        (item["goods_desc"] !== undefined && !text(item["goods_desc"]))
      )
        return invalid();
      items.push({
        description: text(item["goods_desc"]) ? item["goods_desc"] : null,
        uploadedAtSec: item["upload_time"],
      });
    }
    shipping = {
      logisticsType: raw["logistics_type"],
      deliveryMode: raw["delivery_mode"],
      finished: raw["finish_shipping"],
      items,
    };
  }
  return ok({
    transactionId: order["transaction_id"],
    outTradeNo: order["merchant_trade_no"],
    mchid: order["merchant_id"],
    payerOpenid: order["openid"],
    amountFen: order["paid_amount"],
    state: order["order_state"],
    shipping,
  });
}
