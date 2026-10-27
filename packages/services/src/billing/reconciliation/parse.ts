// 官方4013071246：ALL账单；退款按发起成功日出账，汇总为全部明细之和。
// 与X-04宽松展示解析隔离：资金路径必须同时验证行、日期、七列汇总与数据库整数范围。
export interface CheckedBillLine {
  lineNo: number;
  lineKind: "payment" | "refund";
  tradedAt: Date;
  appid: string;
  mchid: string;
  transactionId: string;
  outTradeNo: string;
  tradeState: string;
  orderAmountFen: number;
  settleAmountFen: number;
  refundId: string | null;
  outRefundNo: string | null;
  refundAmountFen: number | null;
  /** 官方申请全额；退款金额是扣除免充值券后的结算额，不可混用。 */
  applyRefundAmountFen: number | null;
  refundState: string | null;
  attach: string | null;
  feeFen: number;
  rateText: string;
}
export interface CheckedBillSummary {
  totalCount: number;
  settleTotalFen: string;
  refundTotalFen: string;
  feeTotalFen: string;
  orderTotalFen: string;
  applyRefundTotalFen: string;
}
export class BillValidationError extends Error {
  constructor(
    readonly code: string,
    readonly row: number,
  ) {
    super(`账单校验失败：${code}（行${row}）`);
    this.name = "BillValidationError";
  }
}
const INT = 2_147_483_647n;
const BIGINT = 9_223_372_036_854_775_807n;
function reject(code: string, row: number): never {
  throw new BillValidationError(code, row);
}
function fen(value: string, row: number, signed = false, limit = INT): bigint {
  const parts = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!parts || (!signed && parts[1])) reject("money_format", row);
  const whole = parts[2]!.replace(/^0+(?=\d)/, "");
  if (whole.length > (limit === INT ? 8 : 17)) reject("money_overflow", row);
  const abs = BigInt(whole) * 100n + BigInt((parts[3] ?? "").padEnd(2, "0"));
  const result = parts[1] === "-" ? -abs : abs;
  if (result > limit || result < (signed ? -limit - 1n : 0n)) reject("money_overflow", row);
  return result;
}
const required = [
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
const totals = [
  "应结订单总金额",
  "退款总金额",
  "充值券退款总金额",
  "手续费总金额",
  "订单总金额",
  "申请退款总金额",
];
function header(cells: string[], fields: string[], row: number) {
  if (new Set(cells).size !== cells.length || fields.some((f) => !cells.includes(f)))
    reject("header", row);
  return new Map(cells.map((f, i) => [f, i]));
}
function data(text: string, length: number, row: number): string[] {
  const cells = text.split(",");
  if (cells.length !== length || cells.some((c) => !c.startsWith("`"))) reject("columns", row);
  return cells.map((c) => c.slice(1));
}
export function parseCheckedTradeBill(bytes: Uint8Array, billDate: string) {
  const day = new Date(`${billDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(billDate) ||
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== billDate
  )
    reject("bill_date", 0);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reject("utf8", 0);
  }
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((text, i) => ({ text, row: i + 1 }))
    .filter((r) => r.text.trim() !== "");
  const first = rows[0];
  if (!first || !first.text.startsWith("交易时间,")) reject("missing_header", first?.row ?? 1);
  const columns = first.text.split(","),
    fields = header(columns, required, first.row);
  const summaryIndex = rows.findIndex((r) => r.text.startsWith("总交易单数,"));
  if (summaryIndex < 1 || summaryIndex !== rows.length - 2) reject("missing_summary", rows.length);
  const summaryHead = rows[summaryIndex]!,
    summaryRow = rows[summaryIndex + 1]!;
  const totalColumns = summaryHead.text.split(",");
  const totalFields = header(totalColumns, ["总交易单数", ...totals], summaryHead.row);
  const summaryCells = data(summaryRow.text, totalColumns.length, summaryRow.row);
  const getTotal = (name: string) => summaryCells[totalFields.get(name)!]!;
  const countText = getTotal("总交易单数");
  if (
    !/^\d+$/.test(countText) ||
    countText.replace(/^0+(?=\d)/, "").length > 10 ||
    BigInt(countText) > INT
  )
    reject("count", summaryRow.row);
  const totalCount = Number(countText);
  const sums = [0n, 0n, 0n, 0n, 0n, 0n];
  const lines: CheckedBillLine[] = [];
  for (const entry of rows.slice(1, summaryIndex)) {
    const cells = data(entry.text, columns.length, entry.row);
    const get = (name: string) => cells[fields.get(name)!]!;
    const state = get("交易状态"),
      payment = state === "SUCCESS";
    if (!["SUCCESS", "REFUND", "REVOKED"].includes(state)) reject("trade_state", entry.row);
    const rawTime = get("交易时间");
    const tradedAt = new Date(`${rawTime.replace(" ", "T")}+08:00`);
    if (
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTime) ||
      !Number.isFinite(tradedAt.getTime()) ||
      rawTime.slice(0, 10) !== billDate ||
      new Date(tradedAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ") !==
        rawTime
    )
      reject("trade_date", entry.row);
    if (get("货币种类") !== "CNY") reject("currency", entry.row);
    const settle = fen(get("应结订单金额"), entry.row),
      order = fen(get("订单金额"), entry.row);
    const refund = fen(get("退款金额"), entry.row),
      coupon = fen(get("充值券退款金额"), entry.row);
    const apply = fen(get("申请退款金额"), entry.row),
      fee = fen(get("手续费"), entry.row, true);
    if (
      payment
        ? order <= 0n ||
          settle > order ||
          refund !== 0n ||
          coupon !== 0n ||
          apply !== 0n ||
          fee < 0n
        : order !== 0n ||
          settle !== 0n ||
          refund > apply ||
          coupon > refund ||
          apply <= 0n ||
          fee > 0n
    )
      reject("money_shape", entry.row);
    const nonzero = (value: string) => value !== "" && value !== "0";
    const refundState = get("退款状态"),
      refundId = get("微信退款单号"),
      outRefundNo = get("商户退款单号");
    if (
      !get("公众账号ID") ||
      !get("商户号") ||
      !get("微信订单号") ||
      !get("商户订单号") ||
      (payment
        ? nonzero(refundId) || nonzero(outRefundNo) || refundState !== ""
        : !nonzero(refundId) ||
          !nonzero(outRefundNo) ||
          !["SUCCESS", "PROCESSING", "FAIL", "CHANGE"].includes(refundState))
    )
      reject("identity", entry.row);
    const amounts = [settle, refund, coupon, fee, order, apply];
    amounts.forEach((amount, i) => {
      sums[i] = sums[i]! + amount;
    });
    lines.push({
      lineNo: lines.length + 1,
      lineKind: payment ? "payment" : "refund",
      tradedAt,
      appid: get("公众账号ID"),
      mchid: get("商户号"),
      transactionId: get("微信订单号"),
      outTradeNo: get("商户订单号"),
      tradeState: state,
      orderAmountFen: Number(order),
      settleAmountFen: Number(settle),
      refundId: payment ? null : refundId,
      outRefundNo: payment ? null : outRefundNo,
      refundAmountFen: payment ? null : Number(refund),
      applyRefundAmountFen: payment ? null : Number(apply),
      refundState: payment ? null : refundState,
      attach: get("商户数据包") || null,
      feeFen: Number(fee),
      rateText: get("费率"),
    });
  }
  if (totalCount !== lines.length) reject("summary_count", summaryRow.row);
  const expected = totals.map((name) =>
    fen(getTotal(name), summaryRow.row, name === "手续费总金额", BIGINT),
  );
  if (expected.some((value, i) => value !== sums[i])) reject("summary_amount", summaryRow.row);
  const summary: CheckedBillSummary = {
    totalCount,
    settleTotalFen: expected[0]!.toString(),
    refundTotalFen: expected[1]!.toString(),
    feeTotalFen: expected[3]!.toString(),
    orderTotalFen: expected[4]!.toString(),
    applyRefundTotalFen: expected[5]!.toString(),
  };
  return { lines, summary };
}
