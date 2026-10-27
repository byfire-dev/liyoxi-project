import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BillValidationError, parseCheckedTradeBill } from "./parse.js";

const DAY = "2026-10-18";
const INT32_MAX = 2_147_483_647n;
const HEAD = [
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
const TOTAL_HEAD = [
  "总交易单数",
  "应结订单总金额",
  "退款总金额",
  "充值券退款总金额",
  "手续费总金额",
  "订单总金额",
  "申请退款总金额",
];
interface RawLine {
  kind: "payment" | "refund";
  order: bigint;
  settle: bigint;
  refund: bigint;
  coupon: bigint;
  fee: bigint;
  apply: bigint;
  refundState: "" | "SUCCESS" | "PROCESSING";
}
function payment(overrides: Partial<RawLine> = {}): RawLine {
  return {
    kind: "payment",
    order: 10_000n,
    settle: 9_000n,
    refund: 0n,
    coupon: 0n,
    fee: 60n,
    apply: 0n,
    refundState: "",
    ...overrides,
  };
}
function refund(overrides: Partial<RawLine> = {}): RawLine {
  return {
    kind: "refund",
    order: 0n,
    settle: 0n,
    refund: 8_000n,
    coupon: 0n,
    fee: -60n,
    apply: 10_000n,
    refundState: "SUCCESS",
    ...overrides,
  };
}
// Independent source model: all expectations and the seven-column footer start as integer fen.
function yuan(fen: bigint): string {
  const absolute = fen < 0n ? -fen : fen;
  return `${fen < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
function totals(rows: readonly RawLine[]): bigint[] {
  const fields = ["settle", "refund", "coupon", "fee", "order", "apply"] as const;
  return [BigInt(rows.length), ...fields.map((key) => rows.reduce((n, row) => n + row[key], 0n))];
}
const quoted = (cells: readonly string[]) => cells.map((cell) => `\`${cell}`).join(",");
function csv(rows: readonly RawLine[], tail: readonly bigint[] | null = totals(rows)): Uint8Array {
  const text = [
    HEAD.join(","),
    ...rows.map((row, index) =>
      quoted([
        `${DAY} 12:34:56`,
        "wx-model",
        "mch-model",
        `wx-${index}`,
        `out-${index}`,
        row.kind === "payment" ? "SUCCESS" : "REFUND",
        "CNY",
        yuan(row.settle),
        row.kind === "payment" ? "0" : `refund-${index}`,
        row.kind === "payment" ? "0" : `out-refund-${index}`,
        yuan(row.refund),
        yuan(row.coupon),
        row.refundState,
        "",
        yuan(row.fee),
        "0.60%",
        yuan(row.order),
        yuan(row.apply),
      ]),
    ),
  ];
  if (tail !== null)
    text.push(TOTAL_HEAD.join(","), quoted(tail.map((n, i) => (i ? yuan(n) : String(n)))));
  return new TextEncoder().encode(`${text.join("\r\n")}\r\n`);
}
function assertModel(rows: readonly RawLine[]): void {
  const result = parseCheckedTradeBill(csv(rows), DAY);
  expect(result.lines).toEqual(
    rows.map((row, index) => ({
      lineNo: index + 1,
      lineKind: row.kind,
      tradedAt: new Date(`${DAY}T12:34:56+08:00`),
      appid: "wx-model",
      mchid: "mch-model",
      transactionId: `wx-${index}`,
      outTradeNo: `out-${index}`,
      tradeState: row.kind === "payment" ? "SUCCESS" : "REFUND",
      orderAmountFen: Number(row.order),
      settleAmountFen: Number(row.settle),
      refundId: row.kind === "payment" ? null : `refund-${index}`,
      outRefundNo: row.kind === "payment" ? null : `out-refund-${index}`,
      refundAmountFen: row.kind === "payment" ? null : Number(row.refund),
      applyRefundAmountFen: row.kind === "payment" ? null : Number(row.apply),
      refundState: row.kind === "payment" ? null : row.refundState,
      attach: null,
      feeFen: Number(row.fee),
      rateText: "0.60%",
    })),
  );
  const total = totals(rows);
  expect(result.summary).toEqual({
    totalCount: rows.length,
    settleTotalFen: String(total[1]),
    refundTotalFen: String(total[2]),
    feeTotalFen: String(total[4]),
    orderTotalFen: String(total[5]),
    applyRefundTotalFen: String(total[6]),
  });
}
function rejects(bytes: Uint8Array, code: string, day = DAY): void {
  let caught: unknown;
  try {
    parseCheckedTradeBill(bytes, day);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BillValidationError);
  expect((caught as BillValidationError).code).toBe(code);
}

describe("checked trade bill: independent integer-fen source model", () => {
  it("preserves a 100-yuan application and 80-yuan settled refund with zero coupon and negative fee", () => {
    assertModel([refund({ apply: 10_000n, refund: 8_000n, coupon: 0n, fee: -60n })]);
  });

  it("matches mixed payments and PROCESSING refunds against raw integers, including nonzero coupon", () => {
    assertModel([payment(), refund({ coupon: 2_000n, refundState: "PROCESSING" })]);
    const values = fc.record({
      order: fc.integer({ min: 1, max: 200_000_000 }),
      settle: fc.nat(200_000_000),
      apply: fc.integer({ min: 1, max: 100_000_000 }),
      refund: fc.nat(100_000_000),
      coupon: fc.nat(100_000_000),
      payFee: fc.nat(100_000),
      refundFee: fc.nat(100_000),
    });
    fc.assert(
      fc.property(values, (v) => {
        const refundFen = BigInt(v.refund % (v.apply + 1));
        assertModel([
          payment({
            order: BigInt(v.order),
            settle: BigInt(v.settle % (v.order + 1)),
            fee: BigInt(v.payFee),
          }),
          refund({
            apply: BigInt(v.apply),
            refund: refundFen,
            coupon: BigInt(v.coupon) % (refundFen + 1n),
            fee: -BigInt(v.refundFee),
            refundState: "PROCESSING",
          }),
        ]);
      }),
      { numRuns: 24, seed: 42 },
    );
  });

  it("rejects a one-fen/count mutation in each of the seven footer columns", () => {
    const rows = [payment(), refund({ coupon: 2_000n, refundState: "PROCESSING" })];
    for (let column = 0; column < TOTAL_HEAD.length; column++) {
      const bad = totals(rows);
      bad[column] = bad[column]! + 1n;
      rejects(csv(rows, bad), column === 0 ? "summary_count" : "summary_amount");
    }
  });

  it("rejects missing footer headers or missing footer data", () => {
    const bytes = csv([payment()], null);
    rejects(bytes, "missing_summary");
    rejects(
      new TextEncoder().encode(`${new TextDecoder().decode(bytes)}${TOTAL_HEAD.join(",")}\r\n`),
      "missing_summary",
    );
  });

  it("accepts int32 boundaries but rejects overflow in every amount column and both fee signs", () => {
    assertModel([payment({ order: INT32_MAX, settle: INT32_MAX, fee: INT32_MAX })]);
    assertModel([refund({ fee: -INT32_MAX - 1n })]);
    const amountFields = ["settle", "refund", "coupon", "fee", "order", "apply"] as const;
    for (const field of amountFields) {
      rejects(csv([payment({ [field]: INT32_MAX + 1n })]), "money_overflow");
    }
    rejects(csv([refund({ fee: -INT32_MAX - 2n })]), "money_overflow");
  });

  it("rejects a valid but different bill day and a nonexistent bill day", () => {
    const bytes = csv([payment(), refund({ refundState: "PROCESSING" })]);
    rejects(bytes, "trade_date", "2026-10-19");
    rejects(bytes, "bill_date", "2026-02-30");
  });
});
