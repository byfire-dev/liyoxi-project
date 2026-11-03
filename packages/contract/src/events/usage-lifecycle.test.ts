import { expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";
const id = "018f0000-0000-7000-8000-000000000001";
const examples = [
  [
    "order.item.usage_end_changed",
    {
      v: 1,
      orderItemId: id,
      dramaOrderId: id,
      prevEndDate: "2024-02-29",
      newEndDate: "2025-03-01",
      usageEndSource: "license",
    },
  ],
  [
    "ticket.archived",
    {
      v: 1,
      deliveryTicketId: id,
      dramaOrderId: id,
      orderItemId: id,
      itemPhase: "ended",
      fromState: "takedown",
      toState: "archived",
      transition: "takedown.all_checked",
    },
  ],
  [
    "takedown.voided",
    {
      v: 1,
      takedownTaskId: id,
      orderItemId: id,
      fromState: "pending_merchant",
      toState: "void",
      transition: "takedown.void",
    },
  ],
] as const;
it.each(examples)("W6-01 %s保留冻结载荷、拒绝缺字段/越界/额外值", (name, body) => {
  const schema = EVENT_PAYLOAD_SCHEMAS[name];
  expect(schema.parse(body)).toEqual(body);
  expect(schema.safeParse({ ...body, undeclared: true }).success).toBe(false);
  expect(schema.safeParse({ ...body, orderItemId: "invalid" }).success).toBe(false);
  expect(schema.safeParse({ ...body, v: 2 }).success).toBe(false);
  for (const field of Object.keys(body)) {
    const incomplete: Record<string, unknown> = { ...body };
    delete incomplete[field];
    expect(schema.safeParse(incomplete).success).toBe(false);
  }
});
it("归档/作废仅接规定迁移，日期变化不冒充状态迁移", () => {
  expect(
    EVENT_PAYLOAD_SCHEMAS["ticket.archived"].safeParse({ ...examples[1][1], itemPhase: "live" })
      .success,
  ).toBe(false);
  expect(
    EVENT_PAYLOAD_SCHEMAS["takedown.voided"].safeParse({ ...examples[2][1], fromState: "checked" })
      .success,
  ).toBe(false);
  expect(
    EVENT_PAYLOAD_SCHEMAS["order.item.usage_end_changed"].safeParse({
      ...examples[0][1],
      ...examples[2][1],
    }).success,
  ).toBe(false);
});
