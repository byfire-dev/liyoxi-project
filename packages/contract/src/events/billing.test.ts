import { describe, expect, it } from "vitest";

import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

// 账本内核发的九个事件（x01 第 3.7 节）：各给一份合格的载荷，另验几处边界。
const ID = "0199a0b0-0000-7000-8000-000000000001";
const OTHER = "0199a0b0-0000-7000-8000-000000000002";

const GOOD = {
  "billing.points.granted": {
    v: 1,
    entityId: ID,
    termId: OTHER,
    grantScheduleId: ID,
    points: 6600,
    monthIndex: 0,
  },
  "billing.points.purchased": { v: 1, entityId: ID, billingOrderId: OTHER, points: 1000 },
  "billing.points.held": {
    v: 1,
    entityId: ID,
    pointHoldId: OTHER,
    points: 2160,
    refType: "order_item",
    refId: ID,
  },
  "billing.points.captured": {
    v: 1,
    entityId: ID,
    pointHoldId: OTHER,
    points: 2160,
    refType: "ad",
    refId: ID,
  },
  "billing.points.returned": {
    v: 1,
    entityId: ID,
    pointHoldId: OTHER,
    returnedPoints: 100,
    convertedPoints: 0,
    forfeitedPoints: 0,
  },
  "billing.points.expired": { v: 1, entityId: ID, termId: OTHER, expiredPoints: 390 },
  "billing.points.adjusted": {
    v: 1,
    entityId: ID,
    pointAdjustmentRequestId: OTHER,
    deltaPoints: -50,
  },
  "billing.subscription.rolled_over": { v: 1, termId: ID, prevTermId: null, entityId: OTHER },
  "billing.subscription.expired": {
    v: 1,
    termId: ID,
    entityId: OTHER,
    endedAt: "2026-02-04T16:00:00.000Z",
  },
} as const;

describe("billing 账本事件的载荷（W1-10）", () => {
  it("九个事件各有 schema，合格的载荷原样通过；多一个键、v 不是 1 都不过", () => {
    for (const [name, payload] of Object.entries(GOOD)) {
      const schema = EVENT_PAYLOAD_SCHEMAS[name as keyof typeof GOOD];
      expect(schema.parse(payload), name).toEqual(payload);
      expect(schema.safeParse({ ...payload, note: "自由文本" }).success, name).toBe(false);
      expect(schema.safeParse({ ...payload, v: 2 }).success, name).toBe(false);
    }
  });

  it("数量的边界：发放、加购、清零大于 0；调整不为 0；冻结的引用类型只有三种", () => {
    const fails = (name: keyof typeof GOOD, patch: Record<string, unknown>): boolean =>
      !EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...GOOD[name], ...patch }).success;
    expect(fails("billing.points.granted", { points: 0 })).toBe(true);
    expect(fails("billing.points.purchased", { points: -1 })).toBe(true);
    expect(fails("billing.points.expired", { expiredPoints: 0 })).toBe(true);
    expect(fails("billing.points.adjusted", { deltaPoints: 0 })).toBe(true);
    expect(fails("billing.points.held", { refType: "drama_order" })).toBe(true);
    expect(fails("billing.points.returned", { forfeitedPoints: -1 })).toBe(true);
    expect(fails("billing.subscription.expired", { endedAt: "2026-02-05" })).toBe(true);
  });
});
