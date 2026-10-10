import { expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";
const body = {
  v: 1,
  deliveryTicketId: "018f0000-0000-7000-8000-000000000001",
  orderItemId: "018f0000-0000-7000-8000-000000000002",
  reason: "cancel_review",
  refId: "018f0000-0000-7000-8000-000000000003",
  fromState: "sample_making",
  toState: "sample_making",
  transition: "ticket.hold",
};
it("ticket.held严格正式载荷", () => {
  expect(EVENT_PAYLOAD_SCHEMAS["ticket.held"].parse(body)).toEqual(body);
});
it.each([
  { v: 2 },
  { deliveryTicketId: "bad" },
  { orderItemId: "bad" },
  { reason: "other" },
  { refId: "bad" },
  { fromState: undefined },
  { surprise: true },
])("拒绝无效暂停载荷%j", (patch) => {
  expect(EVENT_PAYLOAD_SCHEMAS["ticket.held"].safeParse({ ...body, ...patch }).success).toBe(false);
});
