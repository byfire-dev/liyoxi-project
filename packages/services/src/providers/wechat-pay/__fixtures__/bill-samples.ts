// 交易账单样本与生成器。样本是自制的，格式照官方文档 4013071246（交易账单详细说明，bill_type=ALL）：
// 27 列的明细表头、每个字段前一个反引号、7 列的汇总表头与一行汇总数据。金额单位是元、两位小数。
// 不是真实账单：真实账单的口径（退款行的日期、状态取值）由 G4-A、G4-B 在预发复核（V13）。

import type { WechatBillLine, WechatBillSummary } from "../bill.js";

export const BILL_HEADER =
  "交易时间,公众账号ID,商户号,特约商户号,设备号,微信订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类," +
  "应结订单金额,代金券金额,微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包," +
  "手续费,费率,订单金额,申请退款金额,费率备注";

export const BILL_SUMMARY_HEADER =
  "总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额";

/** 整数分 → “元”字符串（两位小数），纯整数运算 */
export function fenToYuan(fen: number): string {
  const abs = Math.abs(fen);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return fen < 0 ? `-${text}` : text;
}

/** 时刻 → 账单里的北京时间写法 */
const beijing = (at: Date): string =>
  new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");

/** 把一行写成账单里的样子：每个字段前一个反引号 */
export function renderBillLine(line: WechatBillLine, openid = "o-test-openid-0001"): string {
  const refund = line.kind === "refund";
  const fields = [
    beijing(line.tradedAt),
    line.appid,
    line.mchid,
    "0",
    "",
    line.transactionId,
    line.outTradeNo,
    openid,
    "JSAPI",
    line.tradeState,
    "OTHERS",
    "CNY",
    fenToYuan(line.settleAmountFen),
    "0.00",
    refund ? (line.refundId ?? "0") : "0",
    refund ? (line.outRefundNo ?? "0") : "0",
    fenToYuan(line.refundAmountFen ?? 0),
    "0.00",
    refund ? "ORIGINAL" : "",
    line.refundState ?? "",
    "狸有戏·套餐",
    line.attach ?? "",
    fenToYuan(line.feeFen),
    line.rateText,
    fenToYuan(line.orderAmountFen),
    fenToYuan(refund ? (line.refundAmountFen ?? 0) : 0),
    "",
  ];
  return fields.map((field) => `\`${field}`).join(",");
}

export function summaryOf(lines: WechatBillLine[]): WechatBillSummary {
  const sum = (pick: (line: WechatBillLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  return {
    totalCount: lines.length,
    settleTotalFen: sum((line) => line.settleAmountFen),
    refundTotalFen: sum((line) => line.refundAmountFen ?? 0),
    feeTotalFen: sum((line) => line.feeFen),
    orderTotalFen: sum((line) => line.orderAmountFen),
    applyRefundTotalFen: sum((line) => line.refundAmountFen ?? 0),
  };
}

/** 生成一份账单文本：表头、明细、汇总表头、汇总数据 */
export function renderTradeBill(lines: WechatBillLine[], eol = "\r\n"): string {
  const summary = summaryOf(lines);
  const summaryRow = [
    String(summary.totalCount),
    fenToYuan(summary.settleTotalFen),
    fenToYuan(summary.refundTotalFen),
    "0.00",
    fenToYuan(summary.feeTotalFen),
    fenToYuan(summary.orderTotalFen),
    fenToYuan(summary.applyRefundTotalFen),
  ];
  return [
    BILL_HEADER,
    ...lines.map((line) => renderBillLine(line)),
    BILL_SUMMARY_HEADER,
    summaryRow.map((field) => `\`${field}`).join(","),
    "",
  ].join(eol);
}

const payment = (
  lineNo: number,
  time: string,
  no: string,
  fen: number,
  feeFen: number,
): WechatBillLine => ({
  lineNo,
  kind: "payment",
  tradedAt: new Date(`2026-10-03T${time}+08:00`),
  appid: "wx0000000000000000",
  mchid: "1900000109",
  transactionId: `42000000002026100300000000${String(lineNo).padStart(2, "0")}`,
  outTradeNo: no,
  tradeState: "SUCCESS",
  settleAmountFen: fen,
  orderAmountFen: fen,
  attach: "v1.e.o.N.r.12",
  feeFen,
  rateText: "0.60%",
});

/** 样本里的五行：四笔收款（0.29、1.10、19.99、144000.00 元）加一笔处理中的退款 */
export const SAMPLE_LINES: WechatBillLine[] = [
  payment(1, "10:00:00", "FK20261003000001a1b2", 29, 0),
  payment(2, "11:30:00", "FK20261003000002c3d4", 110, 1),
  payment(3, "12:00:00", "FK20261003000003e5f6", 1999, 12),
  payment(4, "13:00:00", "FK20261003000004g7h8", 14_400_000, 86_400),
  {
    lineNo: 5,
    kind: "refund",
    tradedAt: new Date("2026-10-03T15:00:00+08:00"),
    appid: "wx0000000000000000",
    mchid: "1900000109",
    transactionId: "4200000000202610030000000003",
    outTradeNo: "FK20261003000003e5f6",
    tradeState: "REFUND",
    settleAmountFen: 0,
    orderAmountFen: 0,
    refundId: "50000000002026100300000000001",
    outRefundNo: "TK20261003000001",
    refundAmountFen: 1999,
    refundState: "PROCESSING",
    attach: "v1.e.o.N.r.12",
    feeFen: -12,
    rateText: "0.60%",
  },
];

/** 写死的样本文本（不经生成器）：解析用例拿它当黄金样本 */
export const SAMPLE_BILL = [
  BILL_HEADER,
  "`2026-10-03 10:00:00,`wx0000000000000000,`1900000109,`0,`,`4200000000202610030000000001,`FK20261003000001a1b2,`o-test-openid-0001,`JSAPI,`SUCCESS,`OTHERS,`CNY,`0.29,`0.00,`0,`0,`0.00,`0.00,`,`,`狸有戏·套餐,`v1.e.o.N.r.12,`0.00,`0.60%,`0.29,`0.00,`",
  "`2026-10-03 11:30:00,`wx0000000000000000,`1900000109,`0,`,`4200000000202610030000000002,`FK20261003000002c3d4,`o-test-openid-0001,`JSAPI,`SUCCESS,`OTHERS,`CNY,`1.10,`0.00,`0,`0,`0.00,`0.00,`,`,`狸有戏·套餐,`v1.e.o.N.r.12,`0.01,`0.60%,`1.10,`0.00,`",
  "`2026-10-03 12:00:00,`wx0000000000000000,`1900000109,`0,`,`4200000000202610030000000003,`FK20261003000003e5f6,`o-test-openid-0001,`JSAPI,`SUCCESS,`OTHERS,`CNY,`19.99,`0.00,`0,`0,`0.00,`0.00,`,`,`狸有戏·套餐,`v1.e.o.N.r.12,`0.12,`0.60%,`19.99,`0.00,`",
  "`2026-10-03 13:00:00,`wx0000000000000000,`1900000109,`0,`,`4200000000202610030000000004,`FK20261003000004g7h8,`o-test-openid-0001,`JSAPI,`SUCCESS,`OTHERS,`CNY,`144000.00,`0.00,`0,`0,`0.00,`0.00,`,`,`狸有戏·套餐,`v1.e.o.N.r.12,`864.00,`0.60%,`144000.00,`0.00,`",
  "`2026-10-03 15:00:00,`wx0000000000000000,`1900000109,`0,`,`4200000000202610030000000003,`FK20261003000003e5f6,`o-test-openid-0001,`JSAPI,`REFUND,`OTHERS,`CNY,`0.00,`0.00,`50000000002026100300000000001,`TK20261003000001,`19.99,`0.00,`ORIGINAL,`PROCESSING,`狸有戏·套餐,`v1.e.o.N.r.12,`-0.12,`0.60%,`0.00,`19.99,`",
  BILL_SUMMARY_HEADER,
  "`5,`144021.38,`19.99,`0.00,`864.01,`144021.38,`19.99",
  "",
].join("\r\n");

/** 当日没有交易时的账单：只有两行表头与全零的汇总 */
export const EMPTY_BILL = [
  BILL_HEADER,
  BILL_SUMMARY_HEADER,
  "`0,`0.00,`0.00,`0.00,`0.00,`0.00,`0.00",
  "",
].join("\r\n");
