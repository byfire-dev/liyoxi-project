import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BILL_HEADER,
  BILL_SUMMARY_HEADER,
  EMPTY_BILL,
  renderTradeBill,
  SAMPLE_BILL,
  SAMPLE_LINES,
  summaryOf,
} from "./__fixtures__/bill-samples.js";
import { parseTradeBill, yuanToFen } from "./bill.js";
import { verifyBillDigest } from "./driver.js";

// 账单（X-04 任务书 第 7 节第 5 条；08 分组第 2.7、2.8 节）：样本解析、摘要校验、“元”到分的定点解析。

describe("“元”字符串定点解析成分", () => {
  it.each([
    ["0.29", 29],
    ["1.10", 110],
    ["19.99", 1999],
    ["144000.00", 14_400_000],
    ["0", 0],
    ["0.00", 0],
    ["0.1", 10],
    ["7", 700],
    ["-0.12", -12],
    ["-0.00", 0],
    ["9999999999999.99", 999_999_999_999_999],
  ])("%s 元 = %i 分", (yuan, fen) => {
    expect(yuanToFen(yuan)).toBe(fen);
  });

  it("这四个金额经浮点会算错，定点解析不会", () => {
    // 0.29 × 100 与 19.99 × 100 在浮点里都不是整数
    expect(0.29 * 100).not.toBe(29);
    expect(19.99 * 100).not.toBe(1999);
    expect([
      yuanToFen("0.29"),
      yuanToFen("1.10"),
      yuanToFen("19.99"),
      yuanToFen("144000.00"),
    ]).toEqual([29, 110, 1999, 14_400_000]);
  });

  it.each([
    "",
    " ",
    "abc",
    "1.234",
    "1,000.00",
    "1e3",
    "0.1.2",
    "+1.00",
    ".5",
    "1.",
    "--1",
    "１.００",
  ])("写法不认的 %j：返回 null", (yuan) => {
    expect(yuanToFen(yuan)).toBeNull();
  });
});

describe("摘要值", () => {
  const bytes = Buffer.from(SAMPLE_BILL);
  const sha1 = createHash("sha1").update(bytes).digest("hex");

  it("一致即通过，大小写与首尾空白不计", () => {
    expect(verifyBillDigest(bytes, sha1)).toBe(true);
    expect(verifyBillDigest(bytes, ` ${sha1.toUpperCase()}\n`)).toBe(true);
  });

  it("摘要值不符即拒收：内容差一个字节、摘要差一位、摘要不是十六进制、长度不对", () => {
    expect(verifyBillDigest(Buffer.from(`${SAMPLE_BILL} `), sha1)).toBe(false);
    expect(verifyBillDigest(bytes, `${sha1.slice(0, -1)}${sha1.endsWith("0") ? "1" : "0"}`)).toBe(
      false,
    );
    expect(verifyBillDigest(bytes, "不是摘要")).toBe(false);
    expect(verifyBillDigest(bytes, sha1.slice(2))).toBe(false);
    expect(verifyBillDigest(bytes, "")).toBe(false);
  });
});

describe("样本解析", () => {
  const parsed = parseTradeBill(SAMPLE_BILL);
  if (!parsed.ok) throw new Error(parsed.reason);

  it("收款行：时间转成时刻（账单写北京时间），金额是整数分", () => {
    expect(parsed.lines).toHaveLength(5);
    expect(parsed.lines[0]).toEqual({
      lineNo: 1,
      kind: "payment",
      tradedAt: new Date("2026-10-03T02:00:00.000Z"),
      appid: "wx0000000000000000",
      mchid: "1900000109",
      transactionId: "4200000000202610030000000001",
      outTradeNo: "FK20261003000001a1b2",
      tradeState: "SUCCESS",
      settleAmountFen: 29,
      orderAmountFen: 29,
      attach: "v1.e.o.N.r.12",
      feeFen: 0,
      rateText: "0.60%",
    });
    expect(parsed.lines.map((line) => line.settleAmountFen)).toEqual([
      29, 110, 1999, 14_400_000, 0,
    ]);
  });

  it("退款行：退款单号、退款金额、出账时的退款状态，手续费为负", () => {
    expect(parsed.lines[4]).toEqual({
      lineNo: 5,
      kind: "refund",
      tradedAt: new Date("2026-10-03T07:00:00.000Z"),
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
    });
  });

  it("尾部汇总行", () => {
    expect(parsed.summary).toEqual({
      totalCount: 5,
      settleTotalFen: 14_402_138,
      refundTotalFen: 1999,
      feeTotalFen: 86_401,
      orderTotalFen: 14_402_138,
      applyRefundTotalFen: 1999,
    });
    expect(parsed.summary).toEqual(summaryOf(parsed.lines));
  });

  it("样本与生成器写出来的一致；解析结果里没有 openid", () => {
    expect(parsed.lines).toEqual(SAMPLE_LINES);
    expect(renderTradeBill(SAMPLE_LINES)).toBe(SAMPLE_BILL);
    expect(JSON.stringify(parsed)).not.toContain("o-test-openid-0001");
  });

  it("空账单：只有表头与全零的汇总行；空文本（当日没有账单）没有汇总", () => {
    expect(parseTradeBill(EMPTY_BILL)).toEqual({
      ok: true,
      lines: [],
      summary: {
        totalCount: 0,
        settleTotalFen: 0,
        refundTotalFen: 0,
        feeTotalFen: 0,
        orderTotalFen: 0,
        applyRefundTotalFen: 0,
      },
    });
    expect(parseTradeBill("")).toEqual({ ok: true, lines: [], summary: null });
    expect(parseTradeBill("\r\n\r\n")).toEqual({ ok: true, lines: [], summary: null });
  });

  it("带字节序标记、换行是 LF、末尾没有空行：同样解析", () => {
    const variant = `\uFEFF${SAMPLE_BILL.replaceAll("\r\n", "\n").trimEnd()}`;
    expect(parseTradeBill(variant)).toEqual(parsed);
  });

  it("列按表头的名字取：微信在后面加列、换了列的先后，都不影响", () => {
    const rows = SAMPLE_BILL.split("\r\n");
    const withExtra = rows.map((row, index) =>
      index === 0 ? `${row},新增的列` : index <= 5 ? `${row},\`新值` : row,
    );
    expect(parseTradeBill(withExtra.join("\r\n"))).toEqual(parsed);
    const moveFirstToLast = (row: string) => {
      const [first, ...others] = row.split(",");
      return [...others, first].join(",");
    };
    const reordered = rows.map((row, index) => (index <= 5 ? moveFirstToLast(row) : row));
    // 表头不再以“交易时间”开头：这是另一种格式，报错而不是猜
    expect(parseTradeBill(reordered.join("\r\n"))).toMatchObject({ ok: false, row: 1 });
  });

  it("已撤销（REVOKED）的行按退款行处理；商户数据包为空时没有 attach", () => {
    const rows = SAMPLE_BILL.split("\r\n");
    rows[5] = (rows[5] ?? "").replace("`REFUND,", "`REVOKED,").replace("`v1.e.o.N.r.12,", "`,");
    const result = parseTradeBill(rows.join("\r\n"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.lines[4]).toMatchObject({ kind: "refund", tradeState: "REVOKED" });
    expect(result.lines[4]?.attach).toBeUndefined();
  });

  it("商户数据包原样保留（微信把逗号转义成反斜杠加空格）", () => {
    const rows = SAMPLE_BILL.split("\r\n");
    rows[1] = (rows[1] ?? "").replace("`v1.e.o.N.r.12,", "`a\\ b\\ ,");
    const result = parseTradeBill(rows.join("\r\n"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.lines[0]?.attach).toBe("a\\ b\\ ");
  });
});

describe("不合规的账单：报错并指出第几行，不给出半截结果", () => {
  const rows = SAMPLE_BILL.split("\r\n");
  const withRow = (index: number, change: (row: string) => string) =>
    rows.map((row, at) => (at === index ? change(row) : row)).join("\r\n");

  it.each([
    ["第一行不是明细表头", "不是账单\r\n", 1, /第一行不是明细表头/],
    [
      "早期格式（没有应结订单金额一列）",
      withRow(0, (row) => row.replace("应结订单金额", "总金额")),
      2,
      /表头缺“应结订单金额”一列/,
    ],
    [
      "金额写法不对",
      withRow(3, (row) => row.replace("`19.99,`0.00,`0,", "`19.9.9,`0.00,`0,")),
      4,
      /“应结订单金额”不是合规的金额/,
    ],
    [
      "金额带千分位",
      withRow(4, (row) => row.replace("`864.00,", "`8 64.00,")),
      5,
      /“手续费”不是合规的金额/,
    ],
    [
      "交易时间写法不对",
      withRow(2, (row) => row.replace("2026-10-03 11:30:00", "2026/10/03 11:30")),
      3,
      /交易时间/,
    ],
    [
      "退款行缺商户退款单号",
      withRow(5, (row) => row.replace("`TK20261003000001,", "`0,")),
      6,
      /退款行缺商户退款单号/,
    ],
    [
      "缺商户订单号",
      withRow(1, (row) => row.replace("`FK20261003000001a1b2,", "`,")),
      2,
      /单号或交易状态为空/,
    ],
    [
      "汇总表头之后没有数据",
      [BILL_HEADER, BILL_SUMMARY_HEADER, ""].join("\r\n"),
      2,
      /恰好一行汇总数据/,
    ],
    ["汇总数据多了一行", `${SAMPLE_BILL}\`1,\`2\r\n`, 8, /恰好一行汇总数据/],
    ["总交易单数不是数", withRow(7, (row) => row.replace("`5,", "`五,")), 8, /总交易单数/],
    ["汇总金额不对", withRow(7, (row) => row.replace("`864.01,", "`x,")), 8, /手续费总金额/],
  ])("%s", (_name, text, row, reason) => {
    const result = parseTradeBill(text);
    expect(result).toMatchObject({ ok: false, row });
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});
