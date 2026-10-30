import { expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018f0000-0000-7000-8000-000000000001";
it("授权版次排队使用正式严格载荷，不接受未来issued字段", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["license_letter.revision_queued"];
  const body = { v: 1, licenseLetterId: id, revisionId: id, reason: "initial" };
  expect(schema.parse(body)).toEqual(body);
  for (const patch of [{ v: 2 }, { revisionId: "bad" }, { reason: "unknown" }, { pdfFileId: id }])
    expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
});
it("授权作废校验真实迁移及作废原因", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["license_letter.voided"];
  const body = {
    v: 1,
    licenseLetterId: id,
    voidReason: "account_removed",
    fromState: "effective",
    toState: "voided",
    transition: "license_letter.void",
  };
  expect(schema.parse(body)).toEqual(body);
  for (const patch of [
    { voidReason: "expired" },
    { fromState: "voided" },
    { toState: "effective" },
    { transition: "other" },
    { note: "extra" },
  ])
    expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
});
