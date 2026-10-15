// 把微信支付的应答与回调资源归一成接口类型（providers/types.ts）。查单应答与支付通知是同一种结构，
// 退款应答与退款通知只差状态的键名（status 与 refund_status）。金额一律整数分：不是安全整数即判为不合规。

import type {
  WechatPayRefund,
  WechatPayRefundStatus,
  WechatPayTradeState,
  WechatPayTransaction,
} from "../types.js";

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 非空字符串，否则 undefined */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** 不为负的整数分，否则 undefined */
export const fen = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function parseObject(raw: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const TRADE_STATES: readonly WechatPayTradeState[] = [
  "SUCCESS",
  "REFUND",
  "NOTPAY",
  "CLOSED",
  "REVOKED",
  "USERPAYING",
  "PAYERROR",
];
const REFUND_STATUSES: readonly WechatPayRefundStatus[] = [
  "SUCCESS",
  "CLOSED",
  "PROCESSING",
  "ABNORMAL",
];

/** 时刻（RFC 3339）；缺省返回 undefined，写错返回 null */
function instant(value: unknown): Date | undefined | null {
  if (value === undefined) return undefined;
  const at = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 查单应答、支付通知解密后的资源 → 交易。缺商户单号、状态不认识、金额或时间写错返回 null */
export function mapTransaction(r: Json): WechatPayTransaction | null {
  const outTradeNo = text(r.out_trade_no);
  const tradeState = TRADE_STATES.find((state) => state === r.trade_state);
  const total = isObject(r.amount) ? r.amount.total : undefined;
  const successAt = instant(r.success_time);
  if (!outTradeNo || !tradeState || successAt === null) return null;
  if (total !== undefined && fen(total) === undefined) return null;
  if (isObject(r.amount) && r.amount.currency !== undefined && r.amount.currency !== "CNY")
    return null;
  return {
    appid: text(r.appid),
    mchid: text(r.mchid),
    outTradeNo,
    tradeState,
    transactionId: text(r.transaction_id),
    amountFen: fen(total),
    payerOpenid: text(isObject(r.payer) ? r.payer.openid : undefined),
    attach: text(r.attach),
    successAt,
  };
}

/** 退款应答、退款通知解密后的资源 → 退款。缺单号、状态不认识、退款金额不是正整数分返回 null */
export function mapRefund(r: Json): WechatPayRefund | null {
  const [outRefundNo, outTradeNo, refundId] = [r.out_refund_no, r.out_trade_no, r.refund_id].map(
    text,
  );
  const raw = r.status ?? r.refund_status;
  const status = REFUND_STATUSES.find((candidate) => candidate === raw);
  const refundFen = fen(isObject(r.amount) ? r.amount.refund : undefined);
  if (!outRefundNo || !outTradeNo || !refundId || !status || !refundFen) return null;
  return { outRefundNo, outTradeNo, refundId, status, refundFen };
}
