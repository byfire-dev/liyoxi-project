/** 原始分向量→当前官方ALL字节。预期资金由调用者独立给定，不调用待测parser/matcher。 */
export interface SourceBillRow {
  outTradeNo: string;
  transactionId: string;
  amountFen?: number;
  feeFen?: number;
  appid?: string;
  mchid?: string;
  attach?: string;
  refund?: {
    outRefundNo: string;
    refundId: string;
    applicationFen: number;
    settlementFen?: number;
    couponFen?: number;
    state?: "SUCCESS" | "PROCESSING";
  };
}
const head = [
  "交易时间",
  "公众账号ID",
  "商户号",
  "微信订单号",
  "商户订单号",
  "交易状态",
  "货币种类",
  "应结订单金额",
  "微信退款单号",
  "商户退款单号",
  "退款金额",
  "充值券退款金额",
  "退款状态",
  "商户数据包",
  "手续费",
  "费率",
  "订单金额",
  "申请退款金额",
];
const footer = [
  "总交易单数",
  "应结订单总金额",
  "退款总金额",
  "充值券退款总金额",
  "手续费总金额",
  "订单总金额",
  "申请退款总金额",
];
const quote = (v: readonly string[]) => v.map((s) => `\`${s}`).join(",");
function yuan(value: bigint) {
  const n = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
export function sourceBill(day: string, rows: readonly SourceBillRow[]) {
  const sums = [0n, 0n, 0n, 0n, 0n, 0n];
  const lines = rows.map((r) => {
    const f = r.refund,
      order = f ? 0n : BigInt(r.amountFen ?? 100),
      apply = BigInt(f?.applicationFen ?? 0);
    const refund = BigInt(f?.settlementFen ?? f?.applicationFen ?? 0),
      coupon = BigInt(f?.couponFen ?? 0),
      fee = BigInt(r.feeFen ?? 0);
    [order, refund, coupon, fee, order, apply].forEach((n, i) => {
      sums[i] = sums[i]! + n;
    });
    return quote([
      `${day} 12:00:00`,
      r.appid ?? "wx0000000000000000",
      r.mchid ?? "1900000109",
      r.transactionId,
      r.outTradeNo,
      f ? "REFUND" : "SUCCESS",
      "CNY",
      yuan(order),
      f?.refundId ?? "0",
      f?.outRefundNo ?? "0",
      yuan(refund),
      yuan(coupon),
      f ? (f.state ?? "SUCCESS") : "",
      r.attach ?? "",
      yuan(fee),
      "0.60%",
      yuan(order),
      yuan(apply),
    ]);
  });
  return (
    [
      head.join(","),
      ...lines,
      footer.join(","),
      quote([String(rows.length), ...sums.map(yuan)]),
    ].join("\r\n") + "\r\n"
  );
}
