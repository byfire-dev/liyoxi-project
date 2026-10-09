import { expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

it("已登记sample.check_rejected仅追加原sample严格迁移载荷", () => {
  const body = {
    v: 1,
    sampleId: "018f0000-0000-7000-8000-000000000001",
    deliveryTicketId: "018f0000-0000-7000-8000-000000000002",
    dramaOrderId: "018f0000-0000-7000-8000-000000000003",
    versionNo: 1,
    fromState: "uploaded",
    toState: "check_rejected",
    transition: "10:641",
  };
  const schema = EVENT_PAYLOAD_SCHEMAS["sample.check_rejected"];
  expect(schema.parse(body)).toEqual(body);
  for (const patch of [{ sampleId: "bad" }, { versionNo: 0 }, { extra: "no" }])
    expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
  const { fromState: _missing, ...withoutFrom } = body;
  expect(schema.safeParse(withoutFrom).success).toBe(false);
  expect(EVENT_PAYLOAD_SCHEMAS["sample.uploaded"].parse(body)).toEqual(body);
});
