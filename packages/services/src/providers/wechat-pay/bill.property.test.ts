import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fenToYuan, renderTradeBill, summaryOf } from "./__fixtures__/bill-samples.js";
import { FC_LABEL, FC_PARAMS, FC_TIMEOUT_MS } from "./__fixtures__/fc.js";
import { parseTradeBill, yuanToFen } from "./bill.js";
import { verifyBillDigest } from "./driver.js";
import type { WechatBillLine } from "./bill.js";

// 性质测试（X-04 任务书 第 7 节第 6 条 ③；甲类必带）：任意账单行集合，生成文本再解析恒等。

const ALNUM = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const idArb = fc.string({ unit: fc.constantFrom(...ALNUM), minLength: 6, maxLength: 32 });
const fenArb = fc.integer({ min: 0, max: 100_000_000_000 });
/** 交易时间只到秒 */
const timeArb = fc
  .integer({ min: 1_577_836_800, max: 2_051_222_400 })
  .map((seconds) => new Date(seconds * 1000));
/** 商户数据包：微信已经把逗号与换行转义掉了，账单里不会有裸的逗号与换行 */
const attachArb = fc
  .string({ unit: "binary", minLength: 1, maxLength: 64 })
  .filter((text) => !/[,\r\n]/.test(text));

const common = {
  lineNo: fc.constant(0),
  tradedAt: timeArb,
  appid: idArb.map((id) => `wx${id}`),
  mchid: fc.integer({ min: 10_000_000, max: 9_999_999_999 }).map(String),
  transactionId: idArb,
  outTradeNo: idArb,
  settleAmountFen: fenArb,
  orderAmountFen: fenArb,
  rateText: fc.constantFrom("0.60%", "0.38%", "0.00%"),
};
const paymentArb: fc.Arbitrary<WechatBillLine> = fc.record(
  {
    ...common,
    kind: fc.constant("payment" as const),
    tradeState: fc.constant("SUCCESS"),
    attach: attachArb,
    feeFen: fenArb,
  },
  { requiredKeys: Object.keys(common).concat("kind", "tradeState", "feeFen") as never },
);
const refundArb: fc.Arbitrary<WechatBillLine> = fc.record(
  {
    ...common,
    kind: fc.constant("refund" as const),
    tradeState: fc.constantFrom("REFUND", "REVOKED"),
    refundId: idArb,
    outRefundNo: idArb,
    refundAmountFen: fenArb,
    refundState: fc.constantFrom("SUCCESS", "PROCESSING", "FAIL", "CHANGE"),
    attach: attachArb,
    feeFen: fenArb.map((fen) => (fen === 0 ? 0 : -fen)),
  },
  {
    requiredKeys: Object.keys(common).concat(
      "kind",
      "tradeState",
      "outRefundNo",
      "refundAmountFen",
      "feeFen",
    ) as never,
  },
);
const linesArb = fc
  .array(fc.oneof(paymentArb, refundArb), { maxLength: 20 })
  .map((lines) => lines.map((line, index) => ({ ...line, lineNo: index + 1 })));

describe(`property: 账单（${FC_LABEL}）`, () => {
  it(
    "property: 任意账单行集合，生成文本再解析恒等；汇总行与明细之和一致",
    () => {
      fc.assert(
        fc.property(linesArb, fc.constantFrom("\r\n", "\n"), (lines, eol) => {
          const text = renderTradeBill(lines, eol);
          const parsed = parseTradeBill(text);
          expect(parsed).toEqual({ ok: true, lines, summary: summaryOf(lines) });
          // 再生成一遍，文本逐字节相同
          if (parsed.ok) expect(renderTradeBill(parsed.lines, eol)).toBe(text);
        }),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );

  it(
    "property: 任意整数分写成“元”再解析恒等，全程不经浮点",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: -999_999_999_999_999, max: 999_999_999_999_999 }), (fen) => {
          expect(yuanToFen(fenToYuan(fen))).toBe(fen);
        }),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );

  it(
    "property: 任意账单文本，摘要一致才通过；改动任一字节即拒收",
    () => {
      fc.assert(
        fc.property(linesArb, fc.nat(), fc.integer({ min: 1, max: 255 }), (lines, at, delta) => {
          const bytes = Buffer.from(renderTradeBill(lines));
          const sha1 = createHash("sha1").update(bytes).digest("hex");
          expect(verifyBillDigest(bytes, sha1)).toBe(true);
          const changed = Buffer.from(bytes);
          const index = at % changed.length;
          changed[index] = ((changed[index] ?? 0) + delta) % 256;
          expect(verifyBillDigest(changed, sha1)).toBe(false);
        }),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );
});
