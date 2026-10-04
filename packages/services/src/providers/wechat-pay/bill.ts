// 交易账单的解析（03 第 1.8 节；08 分组第 2.7、2.8 节）。只做到“把账单文本解析成行”，
// 匹配与差异单归 G4-B；下载与摘要校验在 driver.ts。格式出自官方文档 4013071246（交易账单详细说明，bill_type=ALL）：
//   第一行是明细表头；之后每行一条明细；再一行汇总表头（“总交易单数”开头）；最后一行汇总数据。
//   字段用英文逗号分隔；明细与汇总的每个字段前有一个反引号；商户自定义字段里的逗号已被微信转义，不会出现裸逗号。
//   金额单位是元、两位小数。这里按字符串定点解析成整数分，不经浮点。
// 列按表头的名字取，不按位置：微信往后加列不影响解析；少了要用的列即报错。“用户标识”一列（openid）不取。

/** “元”字符串 → 整数分。只认可选的负号、整数部分、至多两位小数；别的写法返回 null */
export function yuanToFen(yuan: string): number | null {
  const match = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(yuan.trim());
  if (!match) return null;
  const value = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" && value !== 0 ? -value : value;
}

export interface WechatBillLine {
  /** 文件内行号，从 1 起（第一条明细是 1） */
  lineNo: number;
  /** 交易状态 SUCCESS 是收款行，其余（REFUND、REVOKED）是退款行 */
  kind: "payment" | "refund";
  /** 交易时间：支付成功时间，或退款发起成功的时间（不是退款成功时间）。账单写北京时间 */
  tradedAt: Date;
  appid: string;
  mchid: string;
  transactionId: string;
  outTradeNo: string;
  tradeState: string;
  settleAmountFen: number;
  orderAmountFen: number;
  /** 以下四项只有退款行有 */
  refundId?: string;
  outRefundNo?: string;
  refundAmountFen?: number;
  /** 出账时的退款状态，出账后不更新：SUCCESS、PROCESSING、FAIL、CHANGE */
  refundState?: string;
  /** 商户数据包（下单时的回传数据），转义后的原文；没传时没有 */
  attach?: string;
  /** 手续费：收款为正，退款为负 */
  feeFen: number;
  rateText: string;
}

export interface WechatBillSummary {
  totalCount: number;
  settleTotalFen: number;
  refundTotalFen: number;
  feeTotalFen: number;
  orderTotalFen: number;
  applyRefundTotalFen: number;
}

export type WechatBillParseResult =
  | { ok: true; lines: WechatBillLine[]; summary: WechatBillSummary | null }
  /** row：原文里第几行（从 1 起，表头是第 1 行） */
  | { ok: false; row: number; reason: string };

const SUMMARY_HEAD = "总交易单数";

class BillError extends Error {}

/** 一行拆成字段，去掉每个字段前的反引号。字段内容不动（商户数据包里转义出来的空格要留着） */
const cells = (row: string): string[] => row.split(",").map((cell) => cell.replace(/^`/, ""));

/** 表头 → 取值函数：按列名取这一行的字段；表头里没有这个列名即报错 */
function reader(header: string[], row: string[]): (column: string) => string {
  return (column) => {
    const index = header.indexOf(column);
    if (index < 0) throw new BillError(`表头缺“${column}”一列`);
    return row[index] ?? "";
  };
}

function money(get: (column: string) => string, column: string): number {
  const value = yuanToFen(get(column));
  if (value === null) throw new BillError(`“${column}”不是合规的金额`);
  return value;
}

/** “2026-10-03 12:30:05”（北京时间）→ 时刻 */
function beijingTime(value: string): Date {
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? new Date(`${value.replace(" ", "T")}+08:00`)
    : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) throw new BillError("“交易时间”写法不对");
  return at;
}

/** 收款行的退款单号写作 0，留空的也当没有 */
const numberOf = (value: string): string | undefined =>
  value === "" || value === "0" ? undefined : value;

function parseLine(lineNo: number, get: (column: string) => string): WechatBillLine {
  const tradeState = get("交易状态");
  const kind = tradeState === "SUCCESS" ? "payment" : "refund";
  const line: WechatBillLine = {
    lineNo,
    kind,
    tradedAt: beijingTime(get("交易时间")),
    appid: get("公众账号ID"),
    mchid: get("商户号"),
    transactionId: get("微信订单号"),
    outTradeNo: get("商户订单号"),
    tradeState,
    settleAmountFen: money(get, "应结订单金额"),
    orderAmountFen: money(get, "订单金额"),
    attach: get("商户数据包") || undefined,
    feeFen: money(get, "手续费"),
    rateText: get("费率"),
  };
  if (!line.transactionId || !line.outTradeNo || !tradeState)
    throw new BillError("单号或交易状态为空");
  if (kind === "payment") return line;
  const refund = {
    refundId: numberOf(get("微信退款单号")),
    outRefundNo: numberOf(get("商户退款单号")),
    refundAmountFen: money(get, "退款金额"),
    refundState: get("退款状态") || undefined,
  };
  if (!refund.outRefundNo) throw new BillError("退款行缺商户退款单号");
  return { ...line, ...refund };
}

/** 解析交易账单（bill_type=ALL）。空文本（当日没有账单）解析成零行、没有汇总 */
export function parseTradeBill(text: string): WechatBillParseResult {
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((row, index) => ({ row: index + 1, cells: cells(row), blank: row.trim() === "" }))
    .filter((entry) => !entry.blank);
  const [head, ...rest] = rows;
  if (!head) return { ok: true, lines: [], summary: null };
  const lines: WechatBillLine[] = [];
  let summary: WechatBillSummary | null = null;
  let at = head.row;
  try {
    if (head.cells[0] !== "交易时间") throw new BillError("第一行不是明细表头");
    const summaryAt = rest.findIndex((entry) => entry.cells[0] === SUMMARY_HEAD);
    const details = summaryAt < 0 ? rest : rest.slice(0, summaryAt);
    for (const entry of details) {
      at = entry.row;
      lines.push(parseLine(lines.length + 1, reader(head.cells, entry.cells)));
    }
    const [summaryHead, summaryRow, ...extra] = summaryAt < 0 ? [] : rest.slice(summaryAt);
    if (summaryHead) {
      at = summaryRow?.row ?? summaryHead.row;
      if (!summaryRow || extra.length > 0) throw new BillError("汇总表头之后应当恰好一行汇总数据");
      const get = reader(summaryHead.cells, summaryRow.cells);
      const totalCount = Number(get(SUMMARY_HEAD));
      if (!Number.isSafeInteger(totalCount) || totalCount < 0)
        throw new BillError("总交易单数不对");
      summary = {
        totalCount,
        settleTotalFen: money(get, "应结订单总金额"),
        refundTotalFen: money(get, "退款总金额"),
        feeTotalFen: money(get, "手续费总金额"),
        orderTotalFen: money(get, "订单总金额"),
        applyRefundTotalFen: money(get, "申请退款总金额"),
      };
    }
  } catch (error) {
    if (!(error instanceof BillError)) throw error;
    return { ok: false, row: at, reason: error.message };
  }
  return { ok: true, lines, summary };
}
