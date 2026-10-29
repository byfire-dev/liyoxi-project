import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "01900000-0000-7000-8000-00000000000a";
const item = {
  v: 1,
  orderItemId: id,
  dramaOrderId: id,
  cancelRequestId: id,
  fromState: "pending_start",
  toState: "cancelled",
  transition: "cancel.execute",
};
describe("订单取消与资质逾期事件载荷", () => {
  it("取消/退回要求实际非负整数金额，终止只收实际关联与迁移", () => {
    for (const name of ["order.item.cancelled", "order.item.refunded"] as const) {
      const schema = EVENT_PAYLOAD_SCHEMAS[name];
      const value = { ...item, returnedPoints: 80, convertedPoints: 20, forfeitedPoints: 0 };
      expect(schema.parse(value)).toEqual(value);
      for (const changes of [
        { returnedPoints: -1 },
        { convertedPoints: 0.5 },
        { note: "敏感备注" },
      ])
        expect(schema.safeParse({ ...value, ...changes }).success).toBe(false);
      expect(schema.safeParse(item).success).toBe(false);
    }
    expect(EVENT_PAYLOAD_SCHEMAS["order.item.terminated"].parse(item)).toEqual(item);
    expect(
      EVENT_PAYLOAD_SCHEMAS["order.item.terminated"].safeParse({ ...item, returnedPoints: 0 })
        .success,
    ).toBe(false);
  });
  it("七日提醒绑定订单、门店与原始驳回时刻，不收自由文本", () => {
    const schema = EVENT_PAYLOAD_SCHEMAS["order.rejected_stale"];
    const value = { v: 1, dramaOrderId: id, storeId: id, rejectedAt: "2026-10-12T10:00:00.000Z" };
    expect(schema.parse(value)).toEqual(value);
    for (const changes of [{ rejectedAt: "2026-10-12" }, { v: 2 }, { note: "自由文本" }])
      expect(schema.safeParse({ ...value, ...changes }).success).toBe(false);
  });
});
