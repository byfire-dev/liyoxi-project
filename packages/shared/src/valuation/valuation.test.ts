import { describe, expect, it } from "vitest";
import { replayLotValuation } from "./index.js";
import type { ValuationEntry } from "./index.js";

function entries(
  moves: readonly (readonly [
    ValuationEntry["fromBucket"],
    ValuationEntry["toBucket"],
    number,
    string?,
  ])[],
): ValuationEntry[] {
  return moves.map(([fromBucket, toBucket, points, hold], index) => ({
    id: `entry-${index}`,
    seq: BigInt(index + 1),
    fromBucket,
    toBucket,
    points,
    pointHoldId: hold ?? null,
  }));
}

describe("D1口径1的完整批次价值回放", () => {
  it("6,600积分/600,000分的五次手算结果，末笔吃尾差且前缀稳定", () => {
    const input = entries([
      ["external", "available", 6600],
      ["available", "held", 6600, "h"],
      ...[2160, 45, 45, 2700, 1650].map((q) => ["held", "consumed", q, "h"] as const),
    ]);
    const original = structuredClone(input);
    const lot = { originalQty: 6600, costBasisFen: 600000 };
    const result = replayLotValuation(lot, input);
    expect(result.slice(2).map((row) => row.valueFen)).toEqual([
      196363, 4090, 4090, 245456, 150001,
    ]);
    expect(result.at(-1)?.remainingValueFen).toBe(0);
    expect(replayLotValuation(lot, input.slice(0, 4))).toEqual(result.slice(0, 4));
    expect(input).toEqual(original);
  });

  it("先弃2,430再退270只冲回24,546分，不把整笔消耗冲回", () => {
    const result = replayLotValuation(
      { originalQty: 6600, costBasisFen: 600000 },
      entries([
        ["external", "available", 6600],
        ["available", "held", 2700, "h"],
        ["held", "consumed", 2700, "h"],
        ["consumed", "expired", 2430, "h"],
        ["consumed", "available", 270, "h"],
      ]),
    );
    expect(result[2]).toMatchObject({ effect: "recognize", valueFen: 245454 });
    expect(result[3]).toMatchObject({ effect: "none", valueFen: 0 });
    expect(result[4]).toMatchObject({
      effect: "reverse",
      valueFen: 24546,
      remainingValueFen: 379092,
    });
  });

  it("全部14种流向、清零复活/退还/转出与不同价值池守恒", () => {
    const result = replayLotValuation(
      { originalQty: 10, costBasisFen: 101 },
      entries([
        ["external", "available", 10],
        ["available", "held", 6, "h"],
        ["held", "consumed", 4, "h"],
        ["consumed", "available", 1, "h"],
        ["consumed", "converted_out", 1, "h"],
        ["consumed", "expired", 1, "h"],
        ["held", "available", 1, "h"],
        ["held", "converted_out", 1, "h"],
        ["available", "expired", 3],
        ["expired", "available", 1],
        ["expired", "revoked", 1],
        ["available", "held", 1, "other"],
        ["held", "expired", 1, "other"],
        ["available", "revoked", 1],
        ["available", "adjusted_out", 2],
      ]),
    );
    expect(result.map((row) => [row.effect, row.valueFen])).toEqual([
      ["inflow", 101],
      ["none", 0],
      ["recognize", 40],
      ["reverse", 10],
      ["reverse_transfer", 10],
      ["none", 0],
      ["none", 0],
      ["transfer_out", 10],
      ["recognize_breakage", 30],
      ["reverse_breakage", 10],
      ["reverse_breakage_refund", 10],
      ["none", 0],
      ["recognize_breakage", 10],
      ["refund_out", 10],
      ["adjust_out", 21],
    ]);
    expect(result.at(-1)?.remainingValueFen).toBe(0);
    // 上述独立手算：净收入40，转出20，退款20，调整21，剩余0，总成本101。
    const converted = replayLotValuation(
      { originalQty: 1, costBasisFen: null, resolvedConversionValueFen: result[4]!.valueFen },
      entries([["external", "available", 1]]),
    );
    expect(converted[0]).toMatchObject({ valueFen: 10, remainingValueFen: 10 });
  });

  it("缺入账、重复/乱序、越池、未知流向、缺conversion成本均拒绝；零成本仍合法", () => {
    const lot = { originalQty: 10, costBasisFen: 101 };
    const first = entries([["external", "available", 10]])[0]!;
    const invalid = [
      [],
      [first, first],
      [first, { ...first, id: "duplicate-inflow", seq: 2n }],
      entries([
        ["external", "available", 10],
        ["available", "held", 11],
      ]),
      entries([
        ["external", "available", 10],
        ["available", "consumed", 1, "h"],
      ]),
      entries([
        ["external", "available", 10],
        ["available", "held", 1],
        ["held", "consumed", 1],
      ]),
      entries([
        ["external", "available", 10],
        ["available", "held", 1, "a"],
        ["held", "consumed", 1, "a"],
        ["consumed", "available", 1, "b"],
      ]),
      entries([
        ["external", "available", 10],
        ["available", "held", 1, "a"],
        ["held", "expired", 1, "a"],
        ["expired", "available", 1],
      ]),
    ];
    for (const input of invalid) expect(() => replayLotValuation(lot, input)).toThrow();
    expect(() => replayLotValuation({ originalQty: 10, costBasisFen: null }, [first])).toThrow();
    expect(() => replayLotValuation({ ...lot, resolvedConversionValueFen: 1 }, [first])).toThrow();
    expect(replayLotValuation({ originalQty: 10, costBasisFen: 0 }, [first])[0]?.valueFen).toBe(0);
  });

  it("安全整数上界的乘法不丢分，低比例首笔为0而末笔收齐尾差", () => {
    const qty = Number.MAX_SAFE_INTEGER;
    const result = replayLotValuation(
      { originalQty: qty, costBasisFen: qty - 1 },
      entries([
        ["external", "available", qty],
        ["available", "held", qty, "h"],
        ["held", "consumed", 1, "h"],
        ["held", "consumed", qty - 1, "h"],
      ]),
    );
    expect(result[2]).toMatchObject({ valueFen: 0, remainingValueFen: qty - 1 });
    expect(result[3]).toMatchObject({ valueFen: qty - 1, remainingValueFen: 0 });
  });
});
